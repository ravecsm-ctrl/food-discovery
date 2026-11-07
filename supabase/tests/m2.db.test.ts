/**
 * M2 database tests against the real migrations (ENG-020, ENG-021, ENG-023, ENG-025–ENG-027).
 * PRRD: R-007, R-012, R-015, R-016, R-020, R-022, R-024, R-025, R-029 · AT-018, AT-020, AT-027, AT-031.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadCatalog } from "../../src/catalog/index.ts";
import { recentLoad, FATIGUE_V2 } from "../../src/engine/fatigue.ts";
import type { ConfirmedMeal } from "../../src/engine/types.ts";
import { migrationsDir, referenceFileName, referenceSql } from "../../scripts/gen-reference-migration.ts";
import { createDb, type Db } from "./db-harness.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const NOW = new Date().toISOString();
let n = 0;
const rid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const uuid = (i: number) => `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`;

const RPCS = [
  "accept_cloud_consent(text)",
  "withdraw_cloud_consent()",
  "save_preferences(real)",
  "sync_session(uuid,integer,jsonb)",
  "save_meal(uuid,jsonb)",
  "delete_meal(uuid,uuid)",
  "get_my_data()",
  "delete_my_account()",
  "save_strong_preference(uuid,jsonb)",
  "delete_strong_preference(uuid,text)",
];

interface Exposure {
  position: number;
  dishId: string;
  shownAt: string;
  selectionReason: string;
  q: number | null;
  selectionProbability: number;
  reaction: string | null;
  undoneReactions: string[];
  withdrawn: boolean;
}

const omit = (o: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

function session(id: string, over: Record<string, unknown> = {}): Record<string, unknown> & { exposures: Exposure[] } {
  return {
    schemaVersion: 1,
    sessionId: id,
    policyId: "adaptive-v2",
    assignment: "rotation",
    catalogVersion: "catalog-v0.3-draft",
    seed: 42,
    startedAt: NOW,
    updatedAt: NOW,
    hardConstraintsActive: true,
    excludedByConstraints: 7,
    exposures: [
      { position: 1, dishId: "dish-chicken-adobo", shownAt: NOW, selectionReason: "cold_start_variety", q: null, selectionProbability: 1, reaction: "yes", undoneReactions: [], withdrawn: false },
      { position: 2, dishId: "dish-tonkotsu-ramen", shownAt: NOW, selectionReason: "adaptive_utility", q: 0.4, selectionProbability: 1, reaction: null, undoneReactions: [], withdrawn: false },
    ],
    recommendationRuns: [],
    events: [],
    ...over,
  };
}

async function sync(db: Db, user: string, expected: number, s: unknown, req = rid()) {
  const [row] = await db.as<{ r: { version: number } }>(user, "select public.sync_session($1, $2, $3) as r", [req, expected, JSON.stringify(s)]);
  return row!.r.version;
}

async function myData(db: Db, user: string) {
  const [row] = await db.as<{ d: { sessions: Array<Record<string, unknown>>; meals: ConfirmedMeal[]; consent: boolean; profile: unknown } }>(user, "select public.get_my_data() as d");
  return row!.d;
}

let db: Db;
beforeAll(async () => {
  db = await createDb();
  await db.addUser(A);
  await db.addUser(B, { email: "b@example.test" });
  for (const u of [A, B]) await db.as(u, "select public.accept_cloud_consent('privacy-v1')");
}, 60_000);

describe("ENG-020 migrations and reference data", () => {
  it("reference migration matches the bundled catalog and policies (no drift)", () => {
    const v = loadCatalog().catalogVersion;
    const file = referenceFileName(v);
    expect(file, `run npm run db:reference for ${v}`).toBeDefined();
    expect(readFileSync(migrationsDir + file, "utf8")).toBe(referenceSql());
  });

  it("every catalog dish is a valid foreign-key target", async () => {
    const [{ count }] = (await db.admin<{ count: number }>("select count(*)::int as count from public.dish_variants")) as [{ count: number }];
    expect(count).toBe(loadCatalog().dishes.length);
  });

  it("there is no table for dietary restrictions — they stay on the device", async () => {
    const rows = await db.admin("select tablename from pg_tables where schemaname='public' and tablename ilike '%restriction%'");
    expect(rows).toEqual([]);
  });
});

describe("ENG-021 grants and access rules (negative tests, AT-018, R-022)", () => {
  it("signed-in users cannot read or write ANY table directly", async () => {
    const tables = await db.admin<{ tablename: string }>("select tablename from pg_tables where schemaname='public'");
    expect(tables.length).toBeGreaterThan(10);
    for (const { tablename } of tables) {
      await expect(db.as(A, `select * from public.${tablename} limit 1`), tablename).rejects.toThrow(/permission denied/);
      await expect(db.as(A, `delete from public.${tablename}`), tablename).rejects.toThrow(/permission denied/);
    }
  });

  it("every table has row-level security enabled", async () => {
    const rows = await db.admin<{ relname: string }>("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity");
    expect(rows).toEqual([]);
  });

  it("only the reviewed functions are callable, and only when signed in", async () => {
    const fns = await db.admin<{ sig: string; auth: boolean; anon: boolean; pub: boolean }>(`
      select p.oid::regprocedure::text as sig,
        has_function_privilege('authenticated', p.oid, 'execute') as auth,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`);
    const callable = fns.filter((f) => f.auth).map((f) => f.sig.replace("public.", ""));
    expect(callable.sort(), JSON.stringify(callable)).toEqual([...RPCS].sort());
    expect(fns.filter((f) => f.anon || f.pub)).toEqual([]);
  });

  it("anonymous API callers (not signed in) are rejected", async () => {
    await expect(db.asAnon("select public.get_my_data()")).rejects.toThrow(/permission denied/);
  });

  it("security-definer functions pin an empty search_path", async () => {
    const rows = await db.admin<{ sig: string }>(`select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""')`);
    expect(rows).toEqual([]);
  });

  it("another user cannot overwrite, read or correct my records (concealed as NOT_FOUND)", async () => {
    const sid = uuid(900);
    await sync(db, A, 0, session(sid));
    await expect(sync(db, B, 1, session(sid))).rejects.toThrow(/NOT_FOUND/);
    await expect(sync(db, B, 0, session(sid))).rejects.toThrow(/NOT_FOUND/);
    const meal = uuid(901);
    await db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: meal, dishId: "dish-bulalo", consumedAt: NOW, source: "manual" })]);
    await expect(db.as(B, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: meal, dishId: "dish-pork-sisig", consumedAt: NOW, source: "manual" })])).rejects.toThrow(/NOT_FOUND/);
    const [del] = await db.as<{ r: { deleted: boolean } }>(B, "select public.delete_meal($1, $2) as r", [rid(), meal]);
    expect(del!.r.deleted).toBe(false);
    const b = await myData(db, B);
    expect(b.sessions.map((s) => s.sessionId)).not.toContain(sid);
    expect(b.meals.map((m) => m.id)).not.toContain(meal);
    expect((await myData(db, A)).meals.find((m) => m.id === meal)?.dishId).toBe("dish-bulalo");
  });

  it("an idempotency key cannot be replayed by a different user", async () => {
    const req = rid();
    await sync(db, A, 0, session(uuid(902)), req);
    await expect(sync(db, B, 0, session(uuid(903)), req)).rejects.toThrow(/request id reused/);
  });
});

describe("R-025 consent", () => {
  it("nothing is stored before consent, and withdrawal stops further writes", async () => {
    const C = "cccccccc-0000-4000-8000-000000000003";
    await db.addUser(C);
    await expect(sync(db, C, 0, session(uuid(910)))).rejects.toThrow(/CONSENT_REQUIRED/);
    await db.as(C, "select public.accept_cloud_consent('privacy-v1')");
    await db.as(C, "select public.accept_cloud_consent('privacy-v1')"); // repeat is harmless
    await sync(db, C, 0, session(uuid(910)));
    await db.as(C, "select public.withdraw_cloud_consent()");
    await expect(db.as(C, "select public.save_preferences(1.5)")).rejects.toThrow(/CONSENT_REQUIRED/);
    expect((await myData(db, C)).consent).toBe(false);
  });
});

describe("ENG-023 sessions: idempotent, versioned, append-only (R-007, R-029, AT-027)", () => {
  it("round-trips a session exactly and stores only whether avoidances were active", async () => {
    const sid = uuid(1);
    const s = session(sid, {
      recommendationRuns: [{ at: NOW, trigger: "user_request", kind: "tentative", effectiveCards: 1, eligibleCount: 150, noMatch: false, inputDigest: "abc", items: [{ rank: 1, dishId: "dish-chicken-adobo", appealScore: 0.71, reasonCodes: ["CURRENT_SESSION_POSITIVE"] }] }],
      events: [{ type: "dish_selected", at: NOW, dishId: "dish-chicken-adobo", rank: 1, runIndex: 0 }],
    });
    expect(await sync(db, A, 0, s)).toBe(2);
    const back = (await myData(db, A)).sessions.find((x) => x.sessionId === sid)!;
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)));
    expect(norm(omit(back, "updatedAt", "version"))).toEqual(norm({ ...omit(s, "updatedAt"), startedAt: new Date(NOW).toISOString() }));
    const [cons] = await db.admin<{ c: unknown }>("select constraints as c from public.discovery_sessions where id = $1", [sid]);
    expect(cons!.c).toEqual({ hardConstraintsActive: true, excludedByConstraints: 7 });
  });

  it("rejects attempts to store which restrictions were active", async () => {
    await expect(db.admin(`update public.discovery_sessions set constraints = '{"avoidedIngredients":["peanut"]}' where id = $1`, [uuid(1)])).rejects.toThrow(/check constraint/);
  });

  it("a duplicate network submission is one logical operation", async () => {
    const sid = uuid(2);
    const req = rid();
    expect(await sync(db, A, 0, session(sid), req)).toBe(2);
    expect(await sync(db, A, 0, session(sid), req)).toBe(2); // replay returns the original result
    const [c] = await db.admin<{ e: number; r: number }>("select (select count(*)::int from public.card_exposures where session_id=$1) as e, (select count(*)::int from public.reaction_events r join public.card_exposures x on x.id=r.exposure_id where x.session_id=$1) as r", [sid]);
    expect(c).toEqual({ e: 2, r: 1 });
  });

  it("stale writers get SESSION_VERSION_CONFLICT; the current version succeeds", async () => {
    const sid = uuid(3);
    await sync(db, A, 0, session(sid));
    await expect(sync(db, A, 0, session(sid))).rejects.toThrow(/SESSION_VERSION_CONFLICT/);
    await expect(sync(db, A, 5, session(sid))).rejects.toThrow(/SESSION_VERSION_CONFLICT/);
    expect(await sync(db, A, 2, session(sid))).toBe(3);
  });

  it("undo invalidates (never deletes) a reaction; at most one active reaction per card (R-007)", async () => {
    const sid = uuid(4);
    let v = await sync(db, A, 0, session(sid));
    const undone = session(sid);
    undone.exposures = [{ ...undone.exposures[0]!, reaction: null }, undone.exposures[1]!];
    // Device shows Undo before the undone value was recorded in undoneReactions: server still invalidates.
    v = await sync(db, A, v, undone);
    const redo = session(sid);
    redo.exposures = [{ ...redo.exposures[0]!, reaction: "no", undoneReactions: ["yes"] }, redo.exposures[1]!];
    expect(await sync(db, A, v, redo)).toBe(4);
    const rows = await db.admin<{ reaction: string; active: boolean }>(
      "select r.reaction, r.invalidated_at is null as active from public.reaction_events r join public.card_exposures x on x.id=r.exposure_id where x.session_id=$1 and x.position=1 order by r.sequence", [sid]);
    expect(rows).toEqual([{ reaction: "yes", active: false }, { reaction: "no", active: true }]);
    const back = (await myData(db, A)).sessions.find((x) => x.sessionId === sid)! as { exposures: Array<{ reaction: string | null; undoneReactions: string[] }> };
    expect(back.exposures[0]).toMatchObject({ reaction: "no", undoneReactions: ["yes"] });
  });

  it("history that contradicts stored history, unknown dishes, and unknown events are rejected", async () => {
    const sid = uuid(5);
    const v = await sync(db, A, 0, session(sid));
    const changed = session(sid);
    changed.exposures = [{ ...changed.exposures[0]!, dishId: "dish-bulalo" }];
    await expect(sync(db, A, v, changed)).rejects.toThrow(/another dish/);
    await expect(sync(db, A, 0, session(uuid(6), { exposures: [{ ...session("x").exposures[0]!, dishId: "dish-not-real" }] }))).rejects.toThrow(/foreign key/);
    await expect(sync(db, A, 0, session(uuid(7), { events: [{ type: "order_placed", at: NOW }] }))).rejects.toThrow(/event type/);
    await expect(sync(db, A, 0, session(uuid(8), { policyId: "made-up-policy" }))).rejects.toThrow(/foreign key/);
  });

  it("selecting a dish never creates a meal (AT-020, R-016)", async () => {
    const before = (await myData(db, A)).meals.length;
    await sync(db, A, 0, session(uuid(9), { events: [{ type: "dish_selected", at: NOW, dishId: "dish-chicken-adobo", rank: 1, runIndex: 0 }] }));
    expect((await myData(db, A)).meals.length).toBe(before);
  });
});

describe("ENG-025/026 meals and corrections (R-015, R-012)", () => {
  it("creates, corrects and deletes a meal; corrections change derived taste fatigue", async () => {
    const meal = uuid(20);
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    await db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: meal, dishId: "dish-lechon-kawali", consumedAt: at, source: "recall", timeApprox: true })]);
    const catalog = loadCatalog();
    const load = async () => recentLoad(catalog, (await myData(db, A)).meals.filter((m) => m.id === meal), new Date().toISOString(), FATIGUE_V2);
    expect((await load()).load.get("method:fried") ?? 0).toBeGreaterThan(0.5);

    await db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: meal, dishId: "dish-chicken-pho", consumedAt: at, source: "recall", timeApprox: true })]);
    const corrected = await load();
    expect(corrected.load.get("method:fried") ?? 0).toBe(0);
    expect(corrected.load.get("texture:brothy") ?? 0).toBeGreaterThan(0.5);
    const [ev] = await db.admin<{ c: number }>("select count(*)::int as c from public.domain_events where event_type='meal_corrected' and aggregate_id=$1", [meal]);
    expect(ev!.c).toBe(1);

    await db.as(A, "select public.delete_meal($1, $2)", [rid(), meal]);
    expect((await load()).mealsInWindow).toBe(0);
    expect((await db.admin("select 1 from public.dish_variants where id='dish-chicken-pho'")).length).toBe(1); // catalog untouched
  });

  it("validates meals: a dish or a name, not in the future", async () => {
    await expect(db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: uuid(21), consumedAt: NOW, source: "manual" })])).rejects.toThrow(/dish or name/);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await expect(db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: uuid(22), dishId: "dish-bulalo", consumedAt: future, source: "manual" })])).rejects.toThrow(/future/);
    await db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: uuid(23), unrecognizedName: "Lola's champorado", consumedAt: NOW, source: "manual" })]);
    expect((await myData(db, A)).meals.find((m) => m.id === uuid(23))?.unrecognizedName).toBe("Lola's champorado");
  });

  it("satisfaction can only attach to my own meal", async () => {
    const bMeal = uuid(30);
    await db.as(B, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: bMeal, dishId: "dish-bulalo", consumedAt: NOW, source: "manual" })]);
    await sync(db, A, 0, session(uuid(31), { events: [{ type: "satisfaction_recorded", at: NOW, mealId: bMeal, rating: 1 }] }));
    const [c] = await db.admin<{ c: number }>("select count(*)::int as c from public.satisfaction_events where meal_record_id=$1", [bMeal]);
    expect(c!.c).toBe(0);
  });
});

describe("ENG-024 preferences", () => {
  it("saves and returns my variety setting only to me", async () => {
    await db.as(A, "select public.save_preferences(0.5)");
    await expect(db.as(A, "select public.save_preferences(3)")).rejects.toThrow(/variety_seeking/);
    expect((await myData(db, A)).profile).toEqual({ varietySeeking: 0.5 });
    expect((await myData(db, B)).profile).toEqual({ varietySeeking: 1 });
  });
});

describe("ENG-027 account deletion (R-024, AT-031)", () => {
  it("deletes all of my data and my identity, tracks the request, and leaves others and the catalog intact", async () => {
    const D = "dddddddd-0000-4000-8000-000000000004";
    await db.addUser(D);
    await db.as(D, "select public.accept_cloud_consent('privacy-v1')");
    await sync(db, D, 0, session(uuid(40), { events: [{ type: "dish_selected", at: NOW, dishId: "dish-chicken-adobo", rank: 1, runIndex: 0 }] }));
    await db.as(D, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id: uuid(41), dishId: "dish-bulalo", consumedAt: NOW, source: "manual" })]);
    await db.as(D, "select public.save_strong_preference($1, $2)", [rid(), JSON.stringify({ dishId: "dish-bulalo", kind: "favourite", at: NOW })]);
    const bBefore = await myData(db, B);
    const catalogBefore = await db.admin("select count(*) from public.dish_variants");

    const [r] = await db.as<{ r: { status: string; deletionRequestId: string } }>(D, "select public.delete_my_account() as r");
    expect(r!.r.status).toBe("completed");

    const leftovers = await db.admin<{ n: number }>(`select
      (select count(*) from public.discovery_sessions where host_user_id=$1) + (select count(*) from public.meal_records where owner_user_id=$1)
      + (select count(*) from public.domain_events where actor_user_id=$1) + (select count(*) from public.consent_records where owner_id=$1)
      + (select count(*) from public.profiles where user_id=$1) + (select count(*) from public.idempotency_keys where owner_user_id=$1)
      + (select count(*) from public.card_exposures where session_id=$2) + (select count(*) from auth.users where id=$1)
      + (select count(*) from public.strong_preferences where owner_user_id=$1) as n`, [D, uuid(40)]);
    expect(Number(leftovers[0]!.n)).toBe(0);
    const [req] = await db.admin<{ status: string; owner_user_id: string | null }>("select status, owner_user_id from public.deletion_requests where id=$1", [r!.r.deletionRequestId]);
    expect(req).toEqual({ status: "completed", owner_user_id: null });
    expect(await myData(db, B)).toEqual(bBefore);
    expect(await db.admin("select count(*) from public.dish_variants")).toEqual(catalogBefore);
  });
});

describe("M3 Together Mode storage (PRRD J-03, R-011, R-017 · AT-013, AT-014)", () => {
  const exp = (position: number, dishId: string, reaction: string | null, undoneReactions: string[] = []) => ({
    position,
    dishId,
    shownAt: NOW,
    selectionReason: "adaptive_utility",
    q: 0.2,
    selectionProbability: 1,
    reaction,
    undoneReactions,
    withdrawn: false,
  });
  const together = (id: string, exposures: unknown[], events: unknown[] = []) => session(id, { mode: "together", exposures, events, names: { a: "Rave", b: "Sam" } });

  it("round-trips shared votes and disagreements exactly; never stores names", async () => {
    const sid = uuid(500);
    const s = together(sid, [exp(1, "dish-chicken-pho", "yes"), exp(2, "dish-pork-tonkatsu", "a"), exp(3, "dish-bulalo", "no"), exp(4, "dish-beef-pho", "yes", ["b"])]);
    await sync(db, A, 0, s);
    const back = (await myData(db, A)).sessions.find((x) => x.sessionId === sid)!;
    expect(back.mode).toBe("together");
    expect((back.exposures as Array<{ reaction: string | null; undoneReactions: string[] }>).map((e) => [e.reaction, e.undoneReactions])).toEqual([
      ["yes", []],
      ["a", []],
      ["no", []],
      ["yes", ["b"]],
    ]);
    expect(JSON.stringify(back)).not.toMatch(/Rave|Sam/);
  });

  it("a shared vote is ONE shared row; a disagreement is two attributed rows in one action group; the partner has no account", async () => {
    const sid = uuid(501);
    await sync(db, A, 0, together(sid, [exp(1, "dish-chicken-pho", "yes"), exp(2, "dish-pork-tonkatsu", "b")]));
    const rows = await db.admin<{ position: number; scope: string; slot: number | null; reaction: string; grp: string }>(
      `select x.position, r.scope, p.slot, r.reaction, r.action_group_id::text as grp from public.reaction_events r
       join public.card_exposures x on x.id = r.exposure_id left join public.session_participants p on p.id = r.participant_id
       where x.session_id = $1 order by x.position, p.slot nulls first`, [sid]);
    expect(rows.map((r) => omit(r, "grp"))).toEqual([
      { position: 1, scope: "shared", slot: null, reaction: "yes" },
      { position: 2, scope: "individual", slot: 1, reaction: "no" },
      { position: 2, scope: "individual", slot: 2, reaction: "yes" },
    ]);
    expect(rows[1]!.grp).toBe(rows[2]!.grp);
    const parts = await db.admin<{ slot: number; user_id: string | null }>("select slot, user_id from public.session_participants where session_id = $1 order by slot", [sid]);
    expect(parts).toEqual([{ slot: 1, user_id: A }, { slot: 2, user_id: null }]);
  });

  it("undoing a disagreement then agreeing keeps one active action per card", async () => {
    const sid = uuid(502);
    const v = await sync(db, A, 0, together(sid, [exp(1, "dish-chicken-pho", "a")]));
    await sync(db, A, v, together(sid, [exp(1, "dish-chicken-pho", "yes", ["a"])]));
    const active = await db.admin<{ scope: string }>(
      "select r.scope from public.reaction_events r join public.card_exposures x on x.id = r.exposure_id where x.session_id = $1 and r.invalidated_at is null", [sid]);
    expect(active).toEqual([{ scope: "shared" }]);
  });

  it("the database itself refuses an active shared vote alongside active individual ones", async () => {
    const [x] = await db.admin<{ id: string }>("select x.id from public.card_exposures x where x.session_id = $1 and x.position = 2", [uuid(501)]);
    await expect(db.admin(
      "insert into public.reaction_events(action_group_id, exposure_id, actor_user_id, scope, reaction, sequence) values (gen_random_uuid(), $1, $2, 'shared', 'yes', 9)", [x!.id, A],
    )).rejects.toThrow(/cannot both be active/);
  });

  it("a confirmed joint decision is a decision, not a meal (AT-020, R-016, R-017)", async () => {
    const sid = uuid(503);
    const meals = (await myData(db, A)).meals.length;
    await sync(db, A, 0, together(sid, [exp(1, "dish-chicken-pho", "yes")], [{ type: "joint_decision_confirmed", at: NOW, dishId: "dish-chicken-pho", rank: 1, runIndex: 0 }]));
    const [st] = await db.admin<{ state: string }>("select state from public.discovery_sessions where id = $1", [sid]);
    expect(st!.state).toBe("decision_confirmed");
    expect((await myData(db, A)).meals.length).toBe(meals);
  });

  it("rejects disagreement codes in solo sessions and switching a session's mode", async () => {
    await expect(sync(db, A, 0, session(uuid(504), { exposures: [exp(1, "dish-bulalo", "a")] }))).rejects.toThrow(/unknown reaction/);
    const sid = uuid(505);
    const v = await sync(db, A, 0, session(sid));
    await expect(sync(db, A, v, together(sid, [exp(1, "dish-chicken-adobo", "yes")]))).rejects.toThrow(/mode cannot change/);
  });

  it("another user can't see or write my Together session", async () => {
    await expect(sync(db, B, 1, together(uuid(500), []))).rejects.toThrow(/NOT_FOUND/);
    expect((await myData(db, B)).sessions.map((s) => s.sessionId)).not.toContain(uuid(500));
  });
});

describe("library step 2: own described dishes", () => {
  const kebab = { cuisine: "middle_eastern", mains: ["beef"], method: "grilled", type: "wraps", flavors: ["flavor:garlicky", "flavor:spiced"] };
  const save = (id: string, extra: Record<string, unknown>) =>
    db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id, consumedAt: NOW, source: "manual", ...extra })]);

  it("stores a private description with a free-text meal and returns it; corrections are recorded", async () => {
    const id = uuid(700);
    await save(id, { unrecognizedName: "Kebab", ownDish: kebab });
    expect((await myData(db, A)).meals.find((m) => m.id === id)?.ownDish).toEqual(kebab);
    await save(id, { unrecognizedName: "Kebab", ownDish: { ...kebab, method: "fried" } });
    expect((await myData(db, A)).meals.find((m) => m.id === id)?.ownDish?.method).toBe("fried");
    const [ev] = await db.admin<{ p: { descriptionChanged: boolean } }>("select payload as p from public.domain_events where event_type='meal_corrected' and aggregate_id=$1", [id]);
    expect(ev!.p.descriptionChanged).toBe(true);
  });

  it("drops a description when the meal names a listed dish", async () => {
    const id = uuid(701);
    await save(id, { dishId: "dish-doner-kebab", ownDish: kebab });
    expect((await myData(db, A)).meals.find((m) => m.id === id)?.ownDish).toBeUndefined();
  });

  it("rejects anything outside the fixed shape", async () => {
    for (const bad of [
      { ...kebab, secret: "x" },
      { ...kebab, flavors: ["flavor:a", "flavor:b", "flavor:c", "flavor:d"] },
      { ...kebab, mains: ["beef; drop table"] },
      { ...kebab, flavors: ["peanut-free"] },
      { ...kebab, cuisine: 42 },
    ]) {
      await expect(save(uuid(702), { unrecognizedName: "X", ownDish: bad })).rejects.toThrow(/ownDish/);
    }
  });

  it("no catalog dish is created from a description (PRRD §9.4)", async () => {
    const before = await db.admin("select count(*) from public.dish_variants");
    await save(uuid(703), { unrecognizedName: "Lola's kebab", ownDish: kebab });
    expect(await db.admin("select count(*) from public.dish_variants")).toEqual(before);
  });
});

describe("library step 3: meal ratings (R-016)", () => {
  const save = (id: string, extra: Record<string, unknown>) =>
    db.as(A, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id, dishId: "dish-bulalo", consumedAt: NOW, source: "manual", ...extra })]);
  const ratingOf = async (id: string) => (await myData(db, A)).meals.find((m) => m.id === id)?.rating;

  it("sets, replaces and clears one rating per meal", async () => {
    const id = uuid(800);
    await save(id, { rating: 5 });
    expect(await ratingOf(id)).toBe(5);
    await save(id, { rating: 2 });
    expect(await ratingOf(id)).toBe(2);
    const [{ c }] = (await db.admin<{ c: number }>("select count(*)::int as c from public.satisfaction_events where meal_record_id = $1", [id])) as [{ c: number }];
    expect(c).toBe(1);
    await save(id, {});
    expect(await ratingOf(id)).toBeUndefined();
  });

  it("rejects ratings outside 1–5 whole stars", async () => {
    for (const bad of [0, 6, 4.5, "5"]) await expect(save(uuid(801), { rating: bad })).rejects.toThrow(/rating/);
  });

  it("a rating is never a meal by itself and can't be put on someone else's meal", async () => {
    const id = uuid(802);
    await db.as(B, "select public.save_meal($1, $2)", [rid(), JSON.stringify({ id, dishId: "dish-bulalo", consumedAt: NOW, source: "manual" })]);
    await expect(save(id, { rating: 1 })).rejects.toThrow(/NOT_FOUND/);
  });
});

describe("strong preferences: Love it / Not for a while / Never (owner request 2026-11-07)", () => {
  const T = new Date(Date.now() - 60_000).toISOString();
  const later = (days: number) => new Date(Date.parse(T) + days * 86_400_000).toISOString();
  const save = (user: string, pref: Record<string, unknown>) => db.as(user, "select public.save_strong_preference($1, $2)", [rid(), JSON.stringify(pref)]);
  const prefsOf = async (user: string) => ((await myData(db, user)) as unknown as { strongPreferences: unknown[] }).strongPreferences;

  it("saves, replaces (one per dish) and deletes my preferences — only mine", async () => {
    await save(A, { dishId: "dish-bulalo", kind: "favourite", at: T });
    await save(A, { dishId: "dish-dinuguan", kind: "snooze", at: T, until: later(30) });
    expect(await prefsOf(A)).toEqual([
      { dishId: "dish-bulalo", kind: "favourite", at: T },
      { dishId: "dish-dinuguan", kind: "snooze", at: T, until: later(30) },
    ]);
    await save(A, { dishId: "dish-dinuguan", kind: "never", at: T });
    expect(await prefsOf(A)).toContainEqual({ dishId: "dish-dinuguan", kind: "never", at: T });
    expect(await prefsOf(B)).toEqual([]);
    await db.as(B, "select public.delete_strong_preference($1, $2)", [rid(), "dish-bulalo"]);
    expect(await prefsOf(A)).toHaveLength(2); // B can't delete mine
    await db.as(A, "select public.delete_strong_preference($1, $2)", [rid(), "dish-bulalo"]);
    expect(await prefsOf(A)).toEqual([{ dishId: "dish-dinuguan", kind: "never", at: T }]);
  });

  it("validates dish, kind and snooze dates", async () => {
    await expect(save(A, { dishId: "dish-nope", kind: "favourite", at: T })).rejects.toThrow(/dishId/);
    await expect(save(A, { dishId: "dish-bulalo", kind: "allergy", at: T })).rejects.toThrow(/kind/);
    await expect(save(A, { dishId: "dish-bulalo", kind: "snooze", at: T })).rejects.toThrow(/until/);
    await expect(save(A, { dishId: "dish-bulalo", kind: "snooze", at: T, until: T })).rejects.toThrow(/until/);
    await expect(save(A, { dishId: "dish-bulalo", kind: "favourite", at: later(5) })).rejects.toThrow(/future/);
  });

  it("needs consent", async () => {
    const C = "cccccccc-0000-4000-8000-000000000909";
    await db.addUser(C);
    await expect(save(C, { dishId: "dish-bulalo", kind: "favourite", at: T })).rejects.toThrow(/CONSENT_REQUIRED/);
  });

  it("super reactions round-trip as explicit-strength reactions, including undo history", async () => {
    const sid = uuid(950);
    const s = session(sid);
    s.exposures[0] = { ...s.exposures[0]!, reaction: "super_no", undoneReactions: ["super_yes"] };
    await sync(db, A, 0, s);
    const back = (await myData(db, A)).sessions.find((x) => x.sessionId === sid) as { exposures: Exposure[] };
    expect(back.exposures[0]).toMatchObject({ reaction: "super_no", undoneReactions: ["super_yes"] });
    const rows = await db.admin<{ reaction: string; strength: string }>(
      "select r.reaction, r.strength from public.reaction_events r join public.card_exposures e on e.id = r.exposure_id where e.session_id = $1 order by r.sequence",
      [sid],
    );
    expect(rows).toEqual([{ reaction: "yes", strength: "explicit" }, { reaction: "no", strength: "explicit" }]);
    // Replaying the same history is fine; rewriting its strength is not.
    await sync(db, A, 2, s);
    const changed = session(sid);
    changed.exposures[0] = { ...changed.exposures[0]!, reaction: "no", undoneReactions: ["super_yes"] };
    await expect(sync(db, A, 3, changed)).rejects.toThrow(/conflicts/);
  });

  it("Together sessions can't carry super reactions", async () => {
    const s = session(uuid(951), { mode: "together" });
    s.exposures[0] = { ...s.exposures[0]!, reaction: "super_yes" };
    await expect(sync(db, A, 0, s)).rejects.toThrow(/unknown reaction/);
  });
});
