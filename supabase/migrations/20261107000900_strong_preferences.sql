-- Strong preferences (owner request 2026-11-07; the PRRD's deferred strong-preference feedback, now authorized).
-- "Love it" saves a favourite; "Not for a while" hides a dish until a date (30 days on the phone);
-- "Never show again" hides it until the person undoes it. One preference per dish per person.
-- These are TASTE choices, never dietary or safety rules. They are private, consent-gated, deleted with
-- the account, and only reachable through the reviewed functions below (D-12).
-- Cards also record the strength of the reaction: 'super_yes' / 'super_no' on the device ⇄ an 'explicit'
-- yes/no here (solo sessions only; Together Mode never uses strong preferences).

create table public.strong_preferences (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  dish_id text not null references public.dish_variants(id),
  kind text not null check (kind in ('favourite', 'snooze', 'never')),
  chosen_at timestamptz not null,
  snooze_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, dish_id),
  check ((kind = 'snooze') = (snooze_until is not null))
);
alter table public.strong_preferences enable row level security;
revoke all on public.strong_preferences from public, anon, authenticated;

create function public.save_strong_preference(p_request_id uuid, p_pref jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := public.fd_uid();
  prior jsonb;
  dish text := p_pref->>'dishId';
  k text := p_pref->>'kind';
  chosen timestamptz;
  until_ts timestamptz := null;
begin
  perform public.fd_require_consent(u);
  prior := public.fd_replay(p_request_id, u, 'save_strong_preference');
  if prior is not null then return prior; end if;
  if jsonb_typeof(p_pref) <> 'object' or dish is null or not exists (select 1 from public.dish_variants d where d.id = dish) then
    perform public.fd_err('VALIDATION_ERROR', 'dishId');
  end if;
  if k is null or k not in ('favourite', 'snooze', 'never') then perform public.fd_err('VALIDATION_ERROR', 'kind'); end if;
  chosen := public.fd_ts(p_pref->'at', 'at');
  if chosen > now() + interval '1 day' then perform public.fd_err('VALIDATION_ERROR', 'at is in the future'); end if;
  if k = 'snooze' then
    until_ts := public.fd_ts(p_pref->'until', 'until');
    if until_ts <= chosen or until_ts > chosen + interval '400 days' then perform public.fd_err('VALIDATION_ERROR', 'until'); end if;
  end if;
  insert into public.strong_preferences(owner_user_id, dish_id, kind, chosen_at, snooze_until)
    values (u, dish, k, chosen, until_ts)
    on conflict (owner_user_id, dish_id) do update
      set kind = excluded.kind, chosen_at = excluded.chosen_at, snooze_until = excluded.snooze_until, updated_at = now();
  return public.fd_remember(p_request_id, u, 'save_strong_preference', jsonb_build_object('dishId', dish, 'kind', k));
end $$;

create function public.delete_strong_preference(p_request_id uuid, p_dish_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid(); prior jsonb; n int;
begin
  perform public.fd_require_consent(u);
  prior := public.fd_replay(p_request_id, u, 'delete_strong_preference');
  if prior is not null then return prior; end if;
  delete from public.strong_preferences where owner_user_id = u and dish_id = p_dish_id;
  get diagnostics n = row_count;
  return public.fd_remember(p_request_id, u, 'delete_strong_preference', jsonb_build_object('dishId', p_dish_id, 'deleted', n > 0));
end $$;

/* ------------------------------------------------------------------ reaction strength */

drop function public.fd_put_action(uuid, uuid, uuid, boolean, uuid, uuid, integer, integer, text, boolean);
drop function public.fd_put_reaction(uuid, uuid, text, uuid, uuid, integer, integer, text, boolean);

create function public.fd_put_reaction(exp_id uuid, part uuid, scope text, u uuid, sid uuid, pos int, seq int, val text, str text, undone boolean) returns void
language plpgsql set search_path = '' as $$
declare existing public.reaction_events;
begin
  select * into existing from public.reaction_events
    where exposure_id = exp_id and participant_id is not distinct from part and sequence = seq;
  if found then
    if existing.reaction <> val or existing.strength <> str then
      perform public.fd_err('VALIDATION_ERROR', 'reaction history conflicts with stored history');
    end if;
    if undone and existing.invalidated_at is null then
      update public.reaction_events set invalidated_at = now() where id = existing.id;
    end if;
    return;
  end if;
  insert into public.reaction_events(action_group_id, exposure_id, actor_user_id, participant_id, scope, reaction, strength, sequence, invalidated_at)
  values (public.fd_uuid(sid::text || ':' || pos || ':' || seq), exp_id, u, part, scope, val, str, seq, case when undone then now() end);
end $$;

-- One logical action: 'yes'/'no' (solo or shared), 'super_yes'/'super_no' (solo only, explicit strength)
-- or, in Together Mode, 'a'/'b' = only that person wanted it.
create function public.fd_put_action(exp_id uuid, owner_part uuid, partner_part uuid, together boolean, u uuid, sid uuid, pos int, seq int, code text, undone boolean) returns void
language plpgsql set search_path = '' as $$
begin
  if code in ('yes', 'no') then
    if together then
      perform public.fd_put_reaction(exp_id, null, 'shared', u, sid, pos, seq, code, 'ordinary', undone);
    else
      perform public.fd_put_reaction(exp_id, owner_part, 'individual', u, sid, pos, seq, code, 'ordinary', undone);
    end if;
  elsif code in ('super_yes', 'super_no') and not together then
    perform public.fd_put_reaction(exp_id, owner_part, 'individual', u, sid, pos, seq, substr(code, 7), 'explicit', undone);
  elsif code in ('a', 'b') and together then
    perform public.fd_put_reaction(exp_id, owner_part, 'individual', u, sid, pos, seq, case when code = 'a' then 'yes' else 'no' end, 'ordinary', undone);
    perform public.fd_put_reaction(exp_id, partner_part, 'individual', u, sid, pos, seq, case when code = 'b' then 'yes' else 'no' end, 'ordinary', undone);
  else
    perform public.fd_err('VALIDATION_ERROR', 'unknown reaction ' || coalesce(code, 'null'));
  end if;
end $$;

create or replace function public.fd_exposure_reactions(exp uuid, together boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare g record; code text; active text := null; undone jsonb := '[]'::jsonb;
begin
  for g in
    select r.sequence,
           bool_and(r.invalidated_at is null) as is_active,
           max(case when r.strength = 'explicit' then 'super_' || r.reaction else r.reaction end)
             filter (where r.participant_id is null or not together) as plain,
           max(case p.slot when 1 then 'a' else 'b' end) filter (where together and r.participant_id is not null and r.reaction = 'yes') as wanted
    from public.reaction_events r
    left join public.session_participants p on p.id = r.participant_id
    where r.exposure_id = exp
    group by r.sequence order by r.sequence
  loop
    code := coalesce(g.plain, g.wanted);
    if g.is_active then active := code; else undone := undone || to_jsonb(code); end if;
  end loop;
  return jsonb_build_object('reaction', active, 'undoneReactions', undone);
end $$;

/* ------------------------------------------------------------------ read and delete own data */

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
      from public.discovery_sessions ds where ds.host_user_id = u), '[]'::jsonb),
    'strongPreferences', coalesce((select jsonb_agg(jsonb_build_object(
        'dishId', sp.dish_id, 'kind', sp.kind,
        'at', to_char(sp.chosen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        || case when sp.snooze_until is not null
             then jsonb_build_object('until', to_char(sp.snooze_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             else '{}'::jsonb end
        order by sp.dish_id)
      from public.strong_preferences sp where sp.owner_user_id = u), '[]'::jsonb)
  );
end $$;

create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid(); req uuid;
begin
  insert into public.deletion_requests(owner_user_id, status) values (u, 'processing') returning id into req;
  delete from public.strong_preferences where owner_user_id = u;
  delete from public.meal_records where owner_user_id = u;
  delete from public.discovery_sessions where host_user_id = u and mode in ('solo', 'together');
  delete from public.domain_events where actor_user_id = u;
  delete from public.idempotency_keys where owner_user_id = u;
  delete from public.consent_records where owner_id = u;
  delete from public.profiles where user_id = u;
  delete from auth.users where id = u;
  update public.deletion_requests set status = 'completed', completed_at = now() where id = req;
  return jsonb_build_object('deletionRequestId', req, 'status', 'completed');
end $$;

-- Only the reviewed RPCs are callable; helpers stay internal.
revoke execute on function public.save_strong_preference(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.delete_strong_preference(uuid, text) from public, anon, authenticated;
grant execute on function public.save_strong_preference(uuid, jsonb) to authenticated;
grant execute on function public.delete_strong_preference(uuid, text) to authenticated;
revoke execute on function public.fd_put_reaction(uuid, uuid, text, uuid, uuid, integer, integer, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.fd_put_action(uuid, uuid, uuid, boolean, uuid, uuid, integer, integer, text, boolean) from public, anon, authenticated;
revoke execute on function public.fd_exposure_reactions(uuid, boolean) from public, anon, authenticated;
