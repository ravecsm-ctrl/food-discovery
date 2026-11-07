-- Library step 3: star ratings on meals feed the long-term taste profile (taste-v0, computed on the device).
-- A meal's rating is one replaceable satisfaction event with a deterministic id (meal id + ':rating');
-- sending no rating clears it. Selection, consumption and satisfaction stay separate (R-016).
-- Nothing else changes; the taste profile itself is derived on the phone and never stored.

create or replace function public.save_meal(p_request_id uuid, p_meal jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := public.fd_uid();
  prior jsonb;
  mid uuid;
  m public.meal_records;
  consumed timestamptz;
  src_session uuid;
  dish text := nullif(p_meal->>'dishId', '');
  unrec text := nullif(btrim(coalesce(p_meal->>'unrecognizedName', '')), '');
  own jsonb := case when jsonb_typeof(p_meal->'ownDish') = 'object' then p_meal->'ownDish' else null end;
  stars int;
  sat_id uuid;
begin
  perform public.fd_require_consent(u);
  prior := public.fd_replay(p_request_id, u, 'save_meal');
  if prior is not null then return prior; end if;
  begin
    mid := (p_meal->>'id')::uuid;
  exception when invalid_text_representation then perform public.fd_err('VALIDATION_ERROR', 'meal id');
  end;
  consumed := public.fd_ts(p_meal->'consumedAt', 'consumedAt');
  if consumed > now() + interval '1 day' then perform public.fd_err('VALIDATION_ERROR', 'consumedAt is in the future'); end if;
  if dish is not null then unrec := null; own := null; end if;
  if not public.fd_valid_own_dish(own) then perform public.fd_err('VALIDATION_ERROR', 'ownDish'); end if;
  if dish is null and unrec is null then perform public.fd_err('VALIDATION_ERROR', 'dish or name required'); end if;
  begin
    src_session := nullif(p_meal->>'sourceSessionId', '')::uuid;
  exception when invalid_text_representation then src_session := null;
  end;
  if src_session is not null and not exists (select 1 from public.discovery_sessions ds where ds.id = src_session and ds.host_user_id = u) then
    src_session := null;  -- never link a meal to someone else's session
  end if;

  select * into m from public.meal_records where id = mid for update;
  if found then
    if m.owner_user_id is distinct from u then perform public.fd_err('NOT_FOUND'); end if;
    if m.dish_id is distinct from dish or m.unrecognized_dish_name is distinct from unrec or m.consumed_at <> consumed or m.own_dish is distinct from own then
      update public.meal_records set dish_id = dish, unrecognized_dish_name = unrec, consumed_at = consumed, own_dish = own,
        time_approx = coalesce((p_meal->>'timeApprox')::boolean, false), updated_at = now()
      where id = mid;
      insert into public.domain_events(event_type, actor_user_id, aggregate_id, payload)
      values ('meal_corrected', u, mid, jsonb_build_object('dishChanged', m.dish_id is distinct from dish or m.unrecognized_dish_name is distinct from unrec, 'timeChanged', m.consumed_at <> consumed, 'descriptionChanged', m.own_dish is distinct from own));
    end if;
  else
    insert into public.meal_records(id, owner_user_id, source_session_id, dish_id, unrecognized_dish_name, own_dish, consumed_at, time_approx, source)
    values (mid, u, src_session, dish, unrec, own, consumed, coalesce((p_meal->>'timeApprox')::boolean, false), coalesce(p_meal->>'source', 'manual'));
  end if;
  -- How much they enjoyed it (satisfaction ≠ consumption, R-016): one rating per meal, replaceable, removable.
  if jsonb_typeof(p_meal->'rating') = 'number' then
    stars := (p_meal->>'rating')::numeric;
    if stars is null or stars < 1 or stars > 5 or (p_meal->>'rating')::numeric <> stars then perform public.fd_err('VALIDATION_ERROR', 'rating'); end if;
  elsif p_meal ? 'rating' and jsonb_typeof(p_meal->'rating') <> 'null' then
    perform public.fd_err('VALIDATION_ERROR', 'rating');
  end if;
  sat_id := public.fd_uuid(mid::text || ':rating');
  if stars is null then
    delete from public.satisfaction_events where id = sat_id;
  else
    insert into public.satisfaction_events(id, meal_record_id, rating) values (sat_id, mid, stars)
      on conflict (id) do update set rating = excluded.rating, recorded_at = now();
  end if;
  return public.fd_remember(p_request_id, u, 'save_meal', jsonb_build_object('mealId', mid));
end $$;

create or replace function public.get_my_data() returns jsonb
language plpgsql security definer stable set search_path = '' as $$
declare u uuid := public.fd_uid();
begin
  return jsonb_build_object(
    'consent', exists (select 1 from public.consent_records c where c.owner_id = u and c.purpose = 'cloud_food_memory' and c.withdrawn_at is null),
    'profile', (select jsonb_build_object('varietySeeking', p.variety_seeking) from public.profiles p where p.user_id = u),
    'meals', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'dishId', m.dish_id, 'unrecognizedName', m.unrecognized_dish_name,
        'consumedAt', to_char(m.consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'confirmed', true, 'source', m.source, 'timeApprox', m.time_approx,
        'sourceSessionId', m.source_session_id)
        || case when m.own_dish is not null then jsonb_build_object('ownDish', m.own_dish) else '{}'::jsonb end
        || coalesce((select jsonb_build_object('rating', se.rating) from public.satisfaction_events se where se.id = public.fd_uuid(m.id::text || ':rating')), '{}'::jsonb)
        order by m.consumed_at)
      from public.meal_records m where m.owner_user_id = u), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(public.fd_session_json(ds.id) order by ds.started_at)
      from public.discovery_sessions ds where ds.host_user_id = u), '[]'::jsonb)
  );
end $$;
