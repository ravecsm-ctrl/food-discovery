-- M3 step 1: Together Mode on one phone (PRRD J-03, R-002, R-011, R-017; ETD §4.4, §8.10).
-- A Together session has two participants: slot 1 = the signed-in owner ("a"), slot 2 = the partner on the
-- same phone, with NO account (user_id null). Cards are shared exposures (participant_id null).
-- Each card holds ONE logical action per sequence: a shared reaction (scope 'shared'), or — when the pair
-- disagreed — two attributed individual reactions in one action group. A shared Yes is never stored as two
-- individual Yes reactions. Partner names and the partner's restrictions are never sent.
-- The joint decision is its own event; meals stay per person (only the owner logs meals here).

-- One action group may now hold two attributed reactions (ETD §4.4).
alter table public.reaction_events drop constraint reaction_events_action_group_id_key;
alter table public.reaction_events drop constraint reaction_events_exposure_id_sequence_key;
drop index public.one_active_reaction;

create unique index reaction_slot_sequence on public.reaction_events
  (exposure_id, coalesce(participant_id, '00000000-0000-0000-0000-000000000000'::uuid), sequence);
-- At most one active reaction per participant (or one shared reaction) per card.
create unique index one_active_reaction_per_participant on public.reaction_events
  (exposure_id, coalesce(participant_id, '00000000-0000-0000-0000-000000000000'::uuid)) where invalidated_at is null;
create index idx_reaction_group on public.reaction_events(action_group_id);

-- Shared and individual reactions can never both be active on one card (ETD §4.4 integrity rule).
create function public.fd_no_mixed_active_reactions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.invalidated_at is null and exists (
    select 1 from public.reaction_events r
    where r.exposure_id = new.exposure_id and r.id <> new.id and r.invalidated_at is null
      and (r.participant_id is null) <> (new.participant_id is null)) then
    raise exception using errcode = 'P0001', message = 'VALIDATION_ERROR: shared and individual reactions cannot both be active on a card';
  end if;
  return new;
end $$;
create trigger reaction_no_mixed_active before insert or update on public.reaction_events
  for each row execute function public.fd_no_mixed_active_reactions();

drop function public.fd_put_reaction(uuid, uuid, uuid, uuid, integer, integer, text, boolean);

-- Store one reaction row idempotently (deterministic action group per session/position/sequence).
create function public.fd_put_reaction(exp_id uuid, part uuid, scope text, u uuid, sid uuid, pos int, seq int, val text, undone boolean) returns void
language plpgsql set search_path = '' as $$
declare existing public.reaction_events;
begin
  select * into existing from public.reaction_events
    where exposure_id = exp_id and participant_id is not distinct from part and sequence = seq;
  if found then
    if existing.reaction <> val then perform public.fd_err('VALIDATION_ERROR', 'reaction history conflicts with stored history'); end if;
    if undone and existing.invalidated_at is null then
      update public.reaction_events set invalidated_at = now() where id = existing.id;
    end if;
    return;
  end if;
  insert into public.reaction_events(action_group_id, exposure_id, actor_user_id, participant_id, scope, reaction, sequence, invalidated_at)
  values (public.fd_uuid(sid::text || ':' || pos || ':' || seq), exp_id, u, part, scope, val, seq, case when undone then now() end);
end $$;

-- One logical action: 'yes'/'no' (solo or shared) or, in Together Mode, 'a'/'b' = only that person wanted it.
create function public.fd_put_action(exp_id uuid, owner_part uuid, partner_part uuid, together boolean, u uuid, sid uuid, pos int, seq int, code text, undone boolean) returns void
language plpgsql set search_path = '' as $$
begin
  if code in ('yes', 'no') then
    if together then
      perform public.fd_put_reaction(exp_id, null, 'shared', u, sid, pos, seq, code, undone);
    else
      perform public.fd_put_reaction(exp_id, owner_part, 'individual', u, sid, pos, seq, code, undone);
    end if;
  elsif code in ('a', 'b') and together then
    -- Invalidate first so the pair never conflicts with a still-active shared reaction.
    perform public.fd_put_reaction(exp_id, owner_part, 'individual', u, sid, pos, seq, case when code = 'a' then 'yes' else 'no' end, undone);
    perform public.fd_put_reaction(exp_id, partner_part, 'individual', u, sid, pos, seq, case when code = 'b' then 'yes' else 'no' end, undone);
  else
    perform public.fd_err('VALIDATION_ERROR', 'unknown reaction ' || coalesce(code, 'null'));
  end if;
end $$;

-- Reaction history of one card in device format: {reaction, undoneReactions} with 'a'/'b' for disagreements.
create function public.fd_exposure_reactions(exp uuid, together boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare g record; code text; active text := null; undone jsonb := '[]'::jsonb;
begin
  for g in
    select r.sequence,
           bool_and(r.invalidated_at is null) as is_active,
           max(r.reaction) filter (where r.participant_id is null or not together) as plain,
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

create or replace function public.sync_session(p_request_id uuid, p_expected_version integer, p_session jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := public.fd_uid();
  prior jsonb;
  sid uuid;
  s public.discovery_sessions;
  part_id uuid;          -- slot 1: the signed-in owner ("a")
  partner_id uuid;       -- slot 2 in Together Mode: the partner on the same phone ("b"), no account
  together boolean;
  shown_by uuid;         -- exposure owner: the solo participant, or NULL for a shared (Together) card
  active_code text;
  e jsonb; r jsonb; ev jsonb; it jsonb;
  exp_id uuid;
  undone jsonb;
  seq int;
  i int;
  run_id uuid;
  meal uuid;
  new_state text;
  allowed_events constant text[] := array['dish_selected','joint_decision_confirmed','recommendations_dismissed','continued_discovery','meal_consumption_confirmed','meal_not_logged','satisfaction_recorded'];
begin
  perform public.fd_require_consent(u);
  prior := public.fd_replay(p_request_id, u, 'sync_session');
  if prior is not null then return prior; end if;

  if jsonb_typeof(p_session) <> 'object' then perform public.fd_err('VALIDATION_ERROR', 'session'); end if;
  if coalesce(jsonb_array_length(p_session->'exposures'), 0) > 400
     or coalesce(jsonb_array_length(p_session->'events'), 0) > 300
     or coalesce(jsonb_array_length(p_session->'recommendationRuns'), 0) > 150 then
    perform public.fd_err('VALIDATION_ERROR', 'session too large');
  end if;
  begin
    sid := (p_session->>'sessionId')::uuid;
  exception when invalid_text_representation then perform public.fd_err('VALIDATION_ERROR', 'sessionId');
  end;

  select * into s from public.discovery_sessions where id = sid for update;
  if found then
    if s.host_user_id is distinct from u then perform public.fd_err('NOT_FOUND'); end if;  -- conceal others' sessions
    if s.version <> p_expected_version then perform public.fd_err('SESSION_VERSION_CONFLICT', format('expected %s, current %s', p_expected_version, s.version)); end if;
    select id into part_id from public.session_participants where session_id = sid and slot = 1;
    select id into partner_id from public.session_participants where session_id = sid and slot = 2;
  else
    if p_expected_version <> 0 then perform public.fd_err('SESSION_VERSION_CONFLICT', 'session does not exist yet'); end if;
    insert into public.discovery_sessions(id, host_user_id, mode, state, constraints, catalog_version, policy_version, assignment, seed, version, started_at)
    values (sid, u, case when p_session->>'mode' = 'together' then 'together' else 'solo' end, 'discovering',
            jsonb_build_object('hardConstraintsActive', coalesce((p_session->>'hardConstraintsActive')::boolean, false),
                               'excludedByConstraints', coalesce((p_session->>'excludedByConstraints')::int, 0)),
            p_session->>'catalogVersion', p_session->>'policyId', coalesce(p_session->>'assignment', 'rotation'),
            (p_session->>'seed')::bigint, 1, public.fd_ts(p_session->'startedAt', 'startedAt'))
    returning * into s;
    insert into public.session_participants(session_id, slot, user_id, state, joined_at)
      values (sid, 1, u, 'joined', s.started_at) returning id into part_id;
    if s.mode = 'together' then
      -- The partner shares this phone and has no account here: a participant slot with no user (PRRD J-03).
      insert into public.session_participants(session_id, slot, user_id, state, joined_at)
        values (sid, 2, null, 'joined', s.started_at) returning id into partner_id;
    end if;
  end if;
  together := s.mode = 'together';
  if (coalesce(p_session->>'mode', 'solo') = 'together') <> together then
    perform public.fd_err('VALIDATION_ERROR', 'session mode cannot change');
  end if;
  shown_by := case when together then null else part_id end;

  -- Card exposures and their reaction history.
  for e in select * from jsonb_array_elements(coalesce(p_session->'exposures', '[]'::jsonb)) loop
    if together then
      insert into public.card_exposures(session_id, participant_id, dish_id, position, selection_reason, q, selection_probability, withdrawn, shown_at)
      values (sid, null, e->>'dishId', (e->>'position')::int, e->>'selectionReason', (e->>'q')::real,
              (e->>'selectionProbability')::real, coalesce((e->>'withdrawn')::boolean, false), public.fd_ts(e->'shownAt', 'shownAt'))
      on conflict (session_id, position) where participant_id is null do nothing;
    else
      insert into public.card_exposures(session_id, participant_id, dish_id, position, selection_reason, q, selection_probability, withdrawn, shown_at)
      values (sid, part_id, e->>'dishId', (e->>'position')::int, e->>'selectionReason', (e->>'q')::real,
              (e->>'selectionProbability')::real, coalesce((e->>'withdrawn')::boolean, false), public.fd_ts(e->'shownAt', 'shownAt'))
      on conflict (session_id, participant_id, position) where participant_id is not null do nothing;
    end if;
    select id into exp_id from public.card_exposures
      where session_id = sid and participant_id is not distinct from shown_by and position = (e->>'position')::int;
    if (select dish_id from public.card_exposures where id = exp_id) <> e->>'dishId' then
      perform public.fd_err('VALIDATION_ERROR', 'exposure position already holds another dish');
    end if;
    if coalesce((e->>'withdrawn')::boolean, false) then update public.card_exposures set withdrawn = true where id = exp_id; end if;

    -- Canonical history at this position: each undone reaction (invalidated), then the active one.
    undone := coalesce(e->'undoneReactions', '[]'::jsonb);
    seq := 0;
    for r in select * from jsonb_array_elements(undone) loop
      perform public.fd_put_action(exp_id, part_id, partner_id, together, u, sid, (e->>'position')::int, seq, r #>> '{}', true);
      seq := seq + 1;
    end loop;
    active_code := e->>'reaction';
    if active_code is not null then
      perform public.fd_put_action(exp_id, part_id, partner_id, together, u, sid, (e->>'position')::int, seq, active_code, false);
    end if;
    -- A reaction stored as active but no longer present on the device was undone there.
    update public.reaction_events set invalidated_at = now()
      where exposure_id = exp_id and invalidated_at is null and sequence >= seq + (case when e->>'reaction' is not null then 1 else 0 end);
  end loop;

  -- Recommendation runs (append-only, deterministic ids).
  i := 0;
  for r in select * from jsonb_array_elements(coalesce(p_session->'recommendationRuns', '[]'::jsonb)) loop
    run_id := public.fd_uuid(sid::text || ':run:' || i);
    if not exists (select 1 from public.recommendation_runs where id = run_id) then
      insert into public.recommendation_runs(id, session_id, run_index, policy_version, catalog_version, run_kind, trigger, effective_cards, eligible_count, no_match, input_digest, created_at)
      values (run_id, sid, i, s.policy_version, s.catalog_version, r->>'kind', r->>'trigger', (r->>'effectiveCards')::int,
              (r->>'eligibleCount')::int, (r->>'noMatch')::boolean, r->>'inputDigest', public.fd_ts(r->'at', 'run.at'));
      for it in select * from jsonb_array_elements(coalesce(r->'items', '[]'::jsonb)) loop
        insert into public.recommendation_items(run_id, rank, dish_id, appeal_score, reason_codes)
        values (run_id, (it->>'rank')::smallint, it->>'dishId', (it->>'appealScore')::real,
                array(select jsonb_array_elements_text(coalesce(it->'reasonCodes', '[]'::jsonb))));
      end loop;
    end if;
    i := i + 1;
  end loop;

  -- Outcome events. Selection never creates a meal (AT-020); meals are separate records.
  i := 0;
  for ev in select * from jsonb_array_elements(coalesce(p_session->'events', '[]'::jsonb)) loop
    if not (ev->>'type' = any(allowed_events)) then perform public.fd_err('VALIDATION_ERROR', 'event type'); end if;
    insert into public.domain_events(id, event_type, actor_user_id, session_id, event_index, payload, policy_version, created_at)
    values (public.fd_uuid(sid::text || ':evt:' || i), ev->>'type', u, sid, i, ev - 'type', s.policy_version, public.fd_ts(ev->'at', 'event.at'))
    on conflict (id) do nothing;
    if ev->>'type' = 'satisfaction_recorded' then
      begin
        meal := (ev->>'mealId')::uuid;
      exception when invalid_text_representation then meal := null;
      end;
      if meal is not null and exists (select 1 from public.meal_records m where m.id = meal and m.owner_user_id = u) then
        insert into public.satisfaction_events(id, meal_record_id, rating, recorded_at)
        values (public.fd_uuid(sid::text || ':sat:' || i), meal, (ev->>'rating')::smallint, public.fd_ts(ev->'at', 'event.at'))
        on conflict (id) do nothing;
      end if;
    end if;
    i := i + 1;
  end loop;

  new_state := case
    when exists (select 1 from public.domain_events d where d.session_id = sid and d.event_type = 'joint_decision_confirmed') then 'decision_confirmed'
    when exists (select 1 from public.domain_events d where d.session_id = sid and d.event_type = 'dish_selected') then 'completed'
    when exists (select 1 from public.recommendation_runs rr where rr.session_id = sid) then 'results_available'
    else 'discovering' end;

  update public.discovery_sessions set version = version + 1, state = new_state, updated_at = now()
    where id = sid returning * into s;
  return public.fd_remember(p_request_id, u, 'sync_session', jsonb_build_object('sessionId', sid, 'version', s.version));
end $$;

create or replace function public.fd_session_json(sid uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'sessionId', s.id,
    'version', s.version,
    'policyId', s.policy_version,
    'assignment', s.assignment,
    'catalogVersion', s.catalog_version,
    'seed', s.seed,
    'startedAt', to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(s.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'hardConstraintsActive', coalesce((s.constraints->>'hardConstraintsActive')::boolean, false),
    'excludedByConstraints', coalesce((s.constraints->>'excludedByConstraints')::int, 0),
    'exposures', coalesce((select jsonb_agg(jsonb_build_object(
        'position', e.position, 'dishId', e.dish_id,
        'shownAt', to_char(e.shown_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'selectionReason', e.selection_reason, 'q', e.q, 'selectionProbability', e.selection_probability,
        'withdrawn', e.withdrawn) || public.fd_exposure_reactions(e.id, s.mode = 'together') order by e.position)
      from public.card_exposures e where e.session_id = s.id), '[]'::jsonb),
    'recommendationRuns', coalesce((select jsonb_agg(jsonb_build_object(
        'at', to_char(rr.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'trigger', rr.trigger, 'kind', rr.run_kind, 'effectiveCards', rr.effective_cards, 'eligibleCount', rr.eligible_count,
        'noMatch', rr.no_match, 'inputDigest', rr.input_digest,
        'items', coalesce((select jsonb_agg(jsonb_build_object('rank', ri.rank, 'dishId', ri.dish_id, 'appealScore', ri.appeal_score, 'reasonCodes', to_jsonb(ri.reason_codes)) order by ri.rank)
                           from public.recommendation_items ri where ri.run_id = rr.id), '[]'::jsonb)) order by rr.run_index)
      from public.recommendation_runs rr where rr.session_id = s.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('type', d.event_type) || d.payload order by d.event_index)
      from public.domain_events d where d.session_id = s.id and d.event_index is not null), '[]'::jsonb)
  ) || case when s.mode = 'together' then jsonb_build_object('mode', 'together') else '{}'::jsonb end
  from public.discovery_sessions s where s.id = sid
$$;

-- Deleting an account removes Together sessions it hosted too (the partner has no account here).
create or replace function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid(); req uuid;
begin
  insert into public.deletion_requests(owner_user_id, status) values (u, 'processing') returning id into req;
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

-- Helpers are internal; only the reviewed RPCs stay callable (sync_session / delete_my_account keep their grants).
revoke execute on function public.fd_put_reaction(uuid, uuid, text, uuid, uuid, integer, integer, text, boolean) from public, anon, authenticated;
revoke execute on function public.fd_put_action(uuid, uuid, uuid, boolean, uuid, uuid, integer, integer, text, boolean) from public, anon, authenticated;
revoke execute on function public.fd_exposure_reactions(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.fd_no_mixed_active_reactions() from public, anon, authenticated;
revoke execute on function public.fd_session_json(uuid) from public, anon, authenticated;
