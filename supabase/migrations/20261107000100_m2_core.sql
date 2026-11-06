-- M2 core schema: persistence, identity, food memory, consent and deletion.
-- ETD §4.2, §4.4, §4.5, §4.6, §4.8, §5.1 · ENG-020, ENG-021, ENG-023–ENG-027
-- R-001, R-007, R-008, R-012, R-015–R-017, R-020, R-022, R-024, R-025, R-029
--
-- Access model (deviation D-12, see docs/m1-implementation-notes.md §7):
--   Browser → Supabase RPC (SECURITY DEFINER function with explicit auth.uid() checks) → transaction.
--   No table is readable or writable by anon/authenticated. RLS is enabled with no policies as a
--   second line of defence. Only the functions granted at the end of this file are callable, and
--   only by signed-in callers (guests are signed-in anonymous users).
--
-- Privacy decisions (product owner, 2026-11-06/07):
--   * Dietary restrictions never leave the device: there is deliberately NO restrictions table here.
--   * Nothing is stored before the person grants the 'cloud_food_memory' consent.
--   * Session constraints store only {hardConstraintsActive, excludedByConstraints} — never which ones.

-- gen_random_uuid() and md5() are core PostgreSQL (13+); no extension needed.

/* ------------------------------------------------------------------ reference data */

create table public.catalog_versions (
  id text primary key,
  status text not null check (status in ('draft','published','retired')),
  created_at timestamptz not null default now()
);

-- Minimal dish identity table so every stored dish reference is validated (full §4.3 food-knowledge
-- schema stays in the versioned JSON catalog for now). Dish ids are stable across catalog versions.
create table public.dish_variants (
  id text primary key check (id ~ '^dish-[a-z0-9-]+$'),
  name text not null,
  cuisine text not null,
  first_catalog_version text not null references public.catalog_versions(id),
  updated_at timestamptz not null default now()
);

create table public.policy_versions (
  id text primary key,
  config jsonb not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

/* ------------------------------------------------------------------ identity (§4.2) */

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  locale text not null default 'en-PH',
  -- 0.5 "I like routine" · 1 normal · 1.5 "I get bored quickly" (taste-fatigue strength, R-008/R-012)
  variety_seeking real not null default 1 check (variety_seeking between 0 and 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('cloud_food_memory')),
  policy_version text not null,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  check (withdrawn_at is null or withdrawn_at >= granted_at)
);
create unique index consent_one_active on public.consent_records(owner_id, purpose) where withdrawn_at is null;

/* ------------------------------------------------------------------ discovery (§4.4) */

create table public.discovery_sessions (
  id uuid primary key,
  host_user_id uuid references auth.users(id) on delete set null,
  mode text not null default 'solo' check (mode in ('solo','together','individual')),
  state text not null check (state in (
    'created','discovering','waiting_for_participant','results_available',
    'decision_confirmed','completed','paused','canceled','expired')),
  -- Privacy: only whether avoidances were active and how many dishes they hid (AT-033).
  constraints jsonb not null default '{}'::jsonb check (
    jsonb_typeof(constraints) = 'object'
    and (constraints - array['hardConstraintsActive','excludedByConstraints']) = '{}'::jsonb),
  catalog_version text not null references public.catalog_versions(id),
  policy_version text not null references public.policy_versions(id),
  assignment text not null check (assignment in ('rotation','manual')),
  seed bigint not null,
  version integer not null default 1 check (version >= 1),
  started_at timestamptz not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.session_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.discovery_sessions(id) on delete cascade,
  slot smallint not null check (slot between 1 and 2),
  user_id uuid references auth.users(id) on delete set null,
  state text not null check (state in ('invited','joined','ready','left')),
  joined_at timestamptz,
  unique (session_id, slot)
);
create unique index session_participant_unique_user on public.session_participants(session_id, user_id) where user_id is not null;

create table public.card_exposures (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.discovery_sessions(id) on delete cascade,
  participant_id uuid references public.session_participants(id) on delete cascade,
  dish_id text not null references public.dish_variants(id),
  position integer not null check (position >= 1),
  selection_reason text not null check (selection_reason in ('fixed_sequence','cold_start_variety','adaptive_utility')),
  q real,
  selection_probability real check (selection_probability > 0 and selection_probability <= 1),
  withdrawn boolean not null default false,
  shown_at timestamptz not null
);
create unique index individual_card_position on public.card_exposures(session_id, participant_id, position) where participant_id is not null;
create unique index shared_card_position on public.card_exposures(session_id, position) where participant_id is null;

create table public.reaction_events (
  id uuid primary key default gen_random_uuid(),
  -- Deterministic per (session, position, sequence) so a retried sync can never duplicate a reaction (AT-027).
  action_group_id uuid not null unique,
  exposure_id uuid not null references public.card_exposures(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  participant_id uuid references public.session_participants(id) on delete cascade,
  scope text not null check (scope in ('shared','individual')),
  reaction text not null check (reaction in ('yes','no')),
  strength text not null default 'ordinary' check (strength in ('ordinary','explicit')),
  sequence smallint not null check (sequence >= 0),
  recorded_at timestamptz not null default now(),
  invalidated_at timestamptz,
  check ((scope = 'shared' and participant_id is null) or (scope = 'individual' and participant_id is not null)),
  unique (exposure_id, sequence)
);
-- Only one active reaction per exposure (§4.4 integrity rule).
create unique index one_active_reaction on public.reaction_events(exposure_id) where invalidated_at is null;

/* ------------------------------------------------------------------ recommendations (§4.5) */

create table public.recommendation_runs (
  id uuid primary key,
  session_id uuid not null references public.discovery_sessions(id) on delete cascade,
  run_index integer not null check (run_index >= 0),
  policy_version text not null references public.policy_versions(id),
  catalog_version text not null references public.catalog_versions(id),
  run_kind text not null check (run_kind in ('tentative','ready','final')),
  trigger text not null check (trigger in ('quick_picks','user_request','readiness_prompt','round_end','exhausted')),
  effective_cards integer not null check (effective_cards >= 0),
  eligible_count integer not null check (eligible_count >= 0),
  no_match boolean not null,
  input_digest text not null,
  created_at timestamptz not null,
  unique (session_id, run_index)
);

create table public.recommendation_items (
  run_id uuid not null references public.recommendation_runs(id) on delete cascade,
  rank smallint not null check (rank between 1 and 3),
  dish_id text not null references public.dish_variants(id),
  appeal_score real not null,
  fulfillment_status text not null default 'unverified' check (fulfillment_status in ('verified','unverified','search_only')),
  reason_codes text[] not null default '{}',
  primary key (run_id, rank),
  unique (run_id, dish_id)
);

/* ------------------------------------------------------------------ food memory (§4.6) */

create table public.meal_records (
  id uuid primary key,
  owner_user_id uuid references auth.users(id) on delete cascade,
  session_participant_id uuid references public.session_participants(id) on delete set null,
  group_id uuid,
  source_session_id uuid references public.discovery_sessions(id) on delete set null,
  dish_id text references public.dish_variants(id),
  unrecognized_dish_name text check (unrecognized_dish_name is null or length(unrecognized_dish_name) between 1 and 80),
  consumed_at timestamptz not null,
  time_approx boolean not null default false,
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null check (source in ('manual','selection_confirmation','session_participant','recall')),
  check (owner_user_id is not null or session_participant_id is not null),
  check (dish_id is not null or unrecognized_dish_name is not null),
  check (not (dish_id is not null and unrecognized_dish_name is not null))
);

create table public.satisfaction_events (
  id uuid primary key,
  meal_record_id uuid not null references public.meal_records(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  recorded_at timestamptz not null default now()
);

create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  session_id uuid references public.discovery_sessions(id) on delete cascade,
  aggregate_id uuid,
  event_index integer,
  payload jsonb not null default '{}'::jsonb,
  policy_version text,
  created_at timestamptz not null default now()
);

create table public.deletion_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete set null,
  status text not null check (status in ('requested','processing','completed','partially_completed','failed')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Idempotency storage (R-029, AT-027): a retried request returns the original result.
create table public.idempotency_keys (
  request_id uuid primary key,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

/* ------------------------------------------------------------------ indexes (§4.7) */

create index idx_session_user on public.session_participants(user_id, session_id);
create index idx_sessions_host on public.discovery_sessions(host_user_id);
create index idx_reaction_exposure on public.reaction_events(exposure_id, recorded_at);
create index idx_meals_owner_date on public.meal_records(owner_user_id, consumed_at desc);
create index idx_meals_session on public.meal_records(source_session_id);
create index idx_recommendation_session on public.recommendation_runs(session_id, created_at desc);
create index idx_domain_events_session on public.domain_events(session_id, created_at);
create index idx_domain_events_actor on public.domain_events(actor_user_id);
create unique index domain_event_session_index on public.domain_events(session_id, event_index) where session_id is not null and event_index is not null;

/* ------------------------------------------------------------------ lock everything down (§5.1) */

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

/* ------------------------------------------------------------------ internal helpers (not granted) */

create function public.fd_err(code text, detail text default null) returns void
language plpgsql set search_path = '' as $$
begin
  -- Message starts with a stable machine code (ETD §6.1 error codes); detail is for humans.
  raise exception using errcode = 'P0001', message = case when detail is null then code else code || ': ' || detail end;
end $$;

-- Verified caller identity; guests are authenticated anonymous users (§5.2).
create function public.fd_uid() returns uuid
language plpgsql stable set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then perform public.fd_err('UNAUTHENTICATED'); end if;
  return u;
end $$;

-- Nothing is stored in the cloud without active consent (R-025).
create function public.fd_require_consent(u uuid) returns void
language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from public.consent_records c
                 where c.owner_id = u and c.purpose = 'cloud_food_memory' and c.withdrawn_at is null) then
    perform public.fd_err('CONSENT_REQUIRED');
  end if;
end $$;

-- Deterministic UUID from text, used for replay-safe child ids.
create function public.fd_uuid(t text) returns uuid
language sql immutable set search_path = '' as $$ select md5(t)::uuid $$;

-- Returns the stored response for a replayed request (or null). Rejects reuse by another caller.
create function public.fd_replay(req uuid, u uuid, op text) returns jsonb
language plpgsql set search_path = '' as $$
declare k public.idempotency_keys;
begin
  if req is null then perform public.fd_err('VALIDATION_ERROR', 'request id required'); end if;
  select * into k from public.idempotency_keys where request_id = req;
  if not found then return null; end if;
  if k.owner_user_id <> u or k.operation <> op then perform public.fd_err('VALIDATION_ERROR', 'request id reused'); end if;
  return k.response;
end $$;

create function public.fd_remember(req uuid, u uuid, op text, resp jsonb) returns jsonb
language plpgsql set search_path = '' as $$
begin
  insert into public.idempotency_keys(request_id, owner_user_id, operation, response) values (req, u, op, resp);
  return resp;
end $$;

create function public.fd_ts(v jsonb, field text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if v is null or jsonb_typeof(v) <> 'string' then perform public.fd_err('VALIDATION_ERROR', field || ' must be a timestamp'); end if;
  return (v #>> '{}')::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
  perform public.fd_err('VALIDATION_ERROR', field || ' must be a timestamp');
end $$;

/* ------------------------------------------------------------------ consent & profile (ENG-022, ENG-024, ENG-027) */

create function public.accept_cloud_consent(p_policy_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid();
begin
  if p_policy_version is null or p_policy_version !~ '^privacy-v[0-9]+$' then perform public.fd_err('VALIDATION_ERROR', 'policy version'); end if;
  insert into public.profiles(user_id) values (u) on conflict (user_id) do nothing;
  insert into public.consent_records(owner_id, purpose, policy_version)
    values (u, 'cloud_food_memory', p_policy_version)
    on conflict (owner_id, purpose) where withdrawn_at is null do nothing;
  insert into public.domain_events(event_type, actor_user_id, payload) values ('consent_granted', u, jsonb_build_object('purpose','cloud_food_memory','policyVersion',p_policy_version));
  return jsonb_build_object('consent', true);
end $$;

-- Withdrawal stops all further cloud writes immediately (R-025). Stored data is removed with delete_my_account.
create function public.withdraw_cloud_consent() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid();
begin
  update public.consent_records set withdrawn_at = now()
    where owner_id = u and purpose = 'cloud_food_memory' and withdrawn_at is null;
  insert into public.domain_events(event_type, actor_user_id, payload) values ('consent_withdrawn', u, jsonb_build_object('purpose','cloud_food_memory'));
  return jsonb_build_object('consent', false);
end $$;

create function public.save_preferences(p_variety_seeking real) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid();
begin
  perform public.fd_require_consent(u);
  if p_variety_seeking is null or p_variety_seeking < 0 or p_variety_seeking > 2 then perform public.fd_err('VALIDATION_ERROR', 'variety_seeking'); end if;
  insert into public.profiles(user_id, variety_seeking) values (u, p_variety_seeking)
    on conflict (user_id) do update set variety_seeking = excluded.variety_seeking, updated_at = now();
  return jsonb_build_object('varietySeeking', p_variety_seeking);
end $$;

/* ------------------------------------------------------------------ sessions (ENG-023) */

-- Merge one on-device session record into the authoritative copy.
-- Optimistic concurrency: p_expected_version must equal the stored version (0 = new session).
-- Idempotent: a replayed p_request_id returns the original result; children have deterministic ids.
-- Exposures and reactions are append-only; undo only invalidates (never deletes) a reaction (R-007).
create function public.sync_session(p_request_id uuid, p_expected_version integer, p_session jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := public.fd_uid();
  prior jsonb;
  sid uuid;
  s public.discovery_sessions;
  part_id uuid;
  e jsonb; r jsonb; ev jsonb; it jsonb;
  exp_id uuid;
  undone jsonb;
  seq int;
  i int;
  run_id uuid;
  meal uuid;
  new_state text;
  allowed_events constant text[] := array['dish_selected','recommendations_dismissed','continued_discovery','meal_consumption_confirmed','meal_not_logged','satisfaction_recorded'];
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
  else
    if p_expected_version <> 0 then perform public.fd_err('SESSION_VERSION_CONFLICT', 'session does not exist yet'); end if;
    insert into public.discovery_sessions(id, host_user_id, mode, state, constraints, catalog_version, policy_version, assignment, seed, version, started_at)
    values (sid, u, 'solo', 'discovering',
            jsonb_build_object('hardConstraintsActive', coalesce((p_session->>'hardConstraintsActive')::boolean, false),
                               'excludedByConstraints', coalesce((p_session->>'excludedByConstraints')::int, 0)),
            p_session->>'catalogVersion', p_session->>'policyId', coalesce(p_session->>'assignment', 'rotation'),
            (p_session->>'seed')::bigint, 1, public.fd_ts(p_session->'startedAt', 'startedAt'))
    returning * into s;
    insert into public.session_participants(session_id, slot, user_id, state, joined_at)
      values (sid, 1, u, 'joined', s.started_at) returning id into part_id;
  end if;

  -- Card exposures and their reaction history.
  for e in select * from jsonb_array_elements(coalesce(p_session->'exposures', '[]'::jsonb)) loop
    insert into public.card_exposures(session_id, participant_id, dish_id, position, selection_reason, q, selection_probability, withdrawn, shown_at)
    values (sid, part_id, e->>'dishId', (e->>'position')::int, e->>'selectionReason', (e->>'q')::real,
            (e->>'selectionProbability')::real, coalesce((e->>'withdrawn')::boolean, false), public.fd_ts(e->'shownAt', 'shownAt'))
    on conflict (session_id, participant_id, position) where participant_id is not null do nothing;
    select id into exp_id from public.card_exposures where session_id = sid and participant_id = part_id and position = (e->>'position')::int;
    if (select dish_id from public.card_exposures where id = exp_id) <> e->>'dishId' then
      perform public.fd_err('VALIDATION_ERROR', 'exposure position already holds another dish');
    end if;
    if coalesce((e->>'withdrawn')::boolean, false) then update public.card_exposures set withdrawn = true where id = exp_id; end if;

    -- Canonical history at this position: each undone reaction (invalidated), then the active one.
    undone := coalesce(e->'undoneReactions', '[]'::jsonb);
    seq := 0;
    for r in select * from jsonb_array_elements(undone) loop
      perform public.fd_put_reaction(exp_id, part_id, u, sid, (e->>'position')::int, seq, r #>> '{}', true);
      seq := seq + 1;
    end loop;
    if e->>'reaction' is not null then
      perform public.fd_put_reaction(exp_id, part_id, u, sid, (e->>'position')::int, seq, e->>'reaction', false);
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
    when exists (select 1 from public.domain_events d where d.session_id = sid and d.event_type = 'dish_selected') then 'completed'
    when exists (select 1 from public.recommendation_runs rr where rr.session_id = sid) then 'results_available'
    else 'discovering' end;

  update public.discovery_sessions set version = version + 1, state = new_state, updated_at = now()
    where id = sid returning * into s;
  return public.fd_remember(p_request_id, u, 'sync_session', jsonb_build_object('sessionId', sid, 'version', s.version));
end $$;

create function public.fd_put_reaction(exp_id uuid, part_id uuid, u uuid, sid uuid, pos int, seq int, val text, undone boolean) returns void
language plpgsql set search_path = '' as $$
declare existing public.reaction_events;
begin
  select * into existing from public.reaction_events where exposure_id = exp_id and sequence = seq;
  if found then
    if existing.reaction <> val then perform public.fd_err('VALIDATION_ERROR', 'reaction history conflicts with stored history'); end if;
    if undone and existing.invalidated_at is null then
      update public.reaction_events set invalidated_at = now() where id = existing.id;
    end if;
    return;
  end if;
  insert into public.reaction_events(action_group_id, exposure_id, actor_user_id, participant_id, scope, reaction, sequence, invalidated_at)
  values (public.fd_uuid(sid::text || ':' || pos || ':' || seq), exp_id, u, part_id, 'individual', val, seq, case when undone then now() end);
end $$;

/* ------------------------------------------------------------------ meals (ENG-025, ENG-026) */

-- Create or correct a confirmed meal. The owner is always the caller (§6.10).
create function public.save_meal(p_request_id uuid, p_meal jsonb) returns jsonb
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
  if dish is not null then unrec := null; end if;
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
    if m.dish_id is distinct from dish or m.unrecognized_dish_name is distinct from unrec or m.consumed_at <> consumed then
      update public.meal_records set dish_id = dish, unrecognized_dish_name = unrec, consumed_at = consumed,
        time_approx = coalesce((p_meal->>'timeApprox')::boolean, false), updated_at = now()
      where id = mid;
      insert into public.domain_events(event_type, actor_user_id, aggregate_id, payload)
      values ('meal_corrected', u, mid, jsonb_build_object('dishChanged', m.dish_id is distinct from dish or m.unrecognized_dish_name is distinct from unrec, 'timeChanged', m.consumed_at <> consumed));
    end if;
  else
    insert into public.meal_records(id, owner_user_id, source_session_id, dish_id, unrecognized_dish_name, consumed_at, time_approx, source)
    values (mid, u, src_session, dish, unrec, consumed, coalesce((p_meal->>'timeApprox')::boolean, false), coalesce(p_meal->>'source', 'manual'));
  end if;
  return public.fd_remember(p_request_id, u, 'save_meal', jsonb_build_object('mealId', mid));
end $$;

create function public.delete_meal(p_request_id uuid, p_meal_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid(); prior jsonb; n int;
begin
  perform public.fd_require_consent(u);
  prior := public.fd_replay(p_request_id, u, 'delete_meal');
  if prior is not null then return prior; end if;
  delete from public.meal_records where id = p_meal_id and owner_user_id = u;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.domain_events(event_type, actor_user_id, aggregate_id) values ('meal_deleted', u, p_meal_id);
  end if;
  return public.fd_remember(p_request_id, u, 'delete_meal', jsonb_build_object('mealId', p_meal_id, 'deleted', n > 0));
end $$;

/* ------------------------------------------------------------------ read own data (R-001 resume, R-022 private by default) */

create function public.get_my_data() returns jsonb
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
        'sourceSessionId', m.source_session_id) order by m.consumed_at)
      from public.meal_records m where m.owner_user_id = u), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(public.fd_session_json(ds.id) order by ds.started_at)
      from public.discovery_sessions ds where ds.host_user_id = u), '[]'::jsonb)
  );
end $$;

create function public.fd_session_json(sid uuid) returns jsonb
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
        'reaction', (select r.reaction from public.reaction_events r where r.exposure_id = e.id and r.invalidated_at is null),
        'undoneReactions', coalesce((select jsonb_agg(r.reaction order by r.sequence) from public.reaction_events r where r.exposure_id = e.id and r.invalidated_at is not null), '[]'::jsonb),
        'withdrawn', e.withdrawn) order by e.position)
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
  )
  from public.discovery_sessions s where s.id = sid
$$;

/* ------------------------------------------------------------------ deletion (ENG-027, R-024, AT-031) */

-- Tracked deletion of everything this person stored, then the identity itself.
-- Catalog and policy reference data are never touched (§4.6 caveat).
create function public.delete_my_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := public.fd_uid(); req uuid;
begin
  insert into public.deletion_requests(owner_user_id, status) values (u, 'processing') returning id into req;
  delete from public.meal_records where owner_user_id = u;
  delete from public.discovery_sessions where host_user_id = u and mode = 'solo';
  delete from public.domain_events where actor_user_id = u;
  delete from public.idempotency_keys where owner_user_id = u;
  delete from public.consent_records where owner_id = u;
  delete from public.profiles where user_id = u;
  delete from auth.users where id = u;
  update public.deletion_requests set status = 'completed', completed_at = now() where id = req;
  return jsonb_build_object('deletionRequestId', req, 'status', 'completed');
end $$;

/* ------------------------------------------------------------------ execute grants: signed-in callers only */

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.accept_cloud_consent(text) to authenticated;
grant execute on function public.withdraw_cloud_consent() to authenticated;
grant execute on function public.save_preferences(real) to authenticated;
grant execute on function public.sync_session(uuid, integer, jsonb) to authenticated;
grant execute on function public.save_meal(uuid, jsonb) to authenticated;
grant execute on function public.delete_meal(uuid, uuid) to authenticated;
grant execute on function public.get_my_data() to authenticated;
grant execute on function public.delete_my_account() to authenticated;
