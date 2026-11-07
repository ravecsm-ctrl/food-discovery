/** Three-way phone ⇄ cloud reconciliation (ENG-023, ENG-025, R-015, R-029). */
import { describe, expect, it } from "vitest";
import type { ConfirmedMeal, StrongPreference } from "@/engine";
import type { EvalSessionRecord } from "./local-store";
import { ledgerAfter, mealHash, planSync, sessionHash, type CloudState, type LocalState } from "./sync-plan";

const U = "user-1";
const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const meal = (n: number, dishId: string | null = "dish-bulalo", at = "2026-11-06T12:00:00.000Z"): ConfirmedMeal => ({
  id: id(n),
  dishId,
  unrecognizedName: dishId ? null : "Champorado",
  consumedAt: at,
  confirmed: true,
  source: "manual",
  timeApprox: false,
});
const sess = (n: number, reactions = 1): EvalSessionRecord => ({
  schemaVersion: 1,
  sessionId: id(100 + n),
  policyId: "adaptive-v2",
  assignment: "rotation",
  catalogVersion: "catalog-v0.3-draft",
  seed: n,
  startedAt: "2026-11-06T12:00:00.000Z",
  updatedAt: "2026-11-06T12:00:00.000Z",
  hardConstraintsActive: false,
  excludedByConstraints: 0,
  exposures: Array.from({ length: reactions }, (_, i) => ({
    position: i + 1,
    dishId: "dish-bulalo",
    shownAt: "2026-11-06T12:00:00.000Z",
    selectionReason: "adaptive_utility",
    q: 0.1234567,
    selectionProbability: 1,
    reaction: "yes" as const,
    undoneReactions: [],
    withdrawn: false,
  })),
  recommendationRuns: [],
  events: [],
});
const local = (meals: ConfirmedMeal[] = [], sessions: EvalSessionRecord[] = [], varietySeeking = 1): LocalState => ({ meals, sessions, varietySeeking });
const cloud = (meals: ConfirmedMeal[] = [], sessions: EvalSessionRecord[] = [], variety: number | null = null): CloudState => ({
  consent: true,
  profile: variety === null ? null : { varietySeeking: variety },
  meals,
  sessions: sessions.map((s) => ({ ...s, version: 2 })),
});

describe("first sync (no ledger)", () => {
  it("pushes phone-only items, pulls cloud-only items, and never deletes anything", () => {
    const p = planSync(local([meal(1)], [sess(1)]), cloud([meal(2)], [sess(2)]), null);
    expect(p.pushMeals.map((m) => m.id)).toEqual([id(1)]);
    expect(p.pullMeals.map((m) => m.id)).toEqual([id(2)]);
    expect(p.pushSessions.map((s) => [s.record.sessionId, s.expectedVersion])).toEqual([[id(101), 0]]);
    expect(p.pullSessions.map((s) => s.sessionId)).toEqual([id(102)]);
    expect(p.deleteCloudMeals).toEqual([]);
    expect(p.removeLocalMeals).toEqual([]);
  });

  it("skips test fixtures and malformed ids instead of failing the whole sync", () => {
    const synthetic = { ...meal(3), source: "synthetic" as const };
    const badId = { ...meal(4), id: "id-123" };
    const p = planSync(local([synthetic, badId], [{ ...sess(3), sessionId: "id-9" }]), cloud(), null);
    expect(p.pushMeals).toEqual([]);
    expect(p.pushSessions).toEqual([]);
    expect(p.skipped).toEqual({ sessions: 1, meals: 2 });
  });
});

describe("after a previous sync (ledger as base)", () => {
  const base = ledgerAfter(U, local([meal(1), meal(2)], [sess(1)], 1), "t");

  it("a meal deleted on this phone is deleted in the cloud; one deleted elsewhere is removed here", () => {
    const p = planSync(local([meal(2)], [sess(1)]), cloud([meal(1)], [sess(1)]), base);
    expect(p.deleteCloudMeals).toEqual([id(1)]);
    expect(p.removeLocalMeals).toEqual([id(2)]);
    expect(p.pushMeals).toEqual([]);
    expect(p.pullMeals).toEqual([]);
  });

  it("a correction on this phone is pushed; a correction made elsewhere is pulled (R-015)", () => {
    const fixedHere = meal(1, "dish-chicken-pho");
    const fixedThere = meal(2, null);
    const p = planSync(local([fixedHere, meal(2)], [sess(1)]), cloud([meal(1), fixedThere], [sess(1)]), base);
    expect(p.pushMeals).toEqual([fixedHere]);
    expect(p.pullMeals.map((m) => [m.id, m.dishId, m.unrecognizedName])).toEqual([[id(2), null, "Champorado"]]);
  });

  it("when both sides changed the same meal, this phone wins", () => {
    const p = planSync(local([meal(1, "dish-pork-sisig"), meal(2)], [sess(1)]), cloud([meal(1, "dish-chicken-pho"), meal(2)], [sess(1)]), base);
    expect(p.pushMeals.map((m) => m.dishId)).toEqual(["dish-pork-sisig"]);
  });

  it("new swipes in an existing session are pushed with the cloud version (optimistic concurrency)", () => {
    const p = planSync(local([meal(1), meal(2)], [sess(1, 3)]), cloud([meal(1), meal(2)], [sess(1, 1)]), base);
    expect(p.pushSessions.map((s) => [s.record.exposures.length, s.expectedVersion])).toEqual([[3, 2]]);
  });

  it("nothing to do when both sides match — float precision and sync timestamps are ignored", () => {
    const cloudCopy = { ...sess(1), updatedAt: "2030-01-01T00:00:00.000Z", exposures: sess(1).exposures.map((e) => ({ ...e, q: 0.12345 })) };
    const p = planSync(local([meal(1), meal(2)], [sess(1)]), cloud([meal(1), meal(2)], [cloudCopy]), base);
    expect(p).toMatchObject({ pushMeals: [], pullMeals: [], pushSessions: [], pullSessions: [], deleteCloudMeals: [], removeLocalMeals: [], pushVariety: null, pullVariety: null });
  });

  it("variety setting: changed here is pushed, changed elsewhere is pulled", () => {
    expect(planSync(local([meal(1), meal(2)], [sess(1)], 1.5), cloud([meal(1), meal(2)], [sess(1)], 1), base).pushVariety).toBe(1.5);
    expect(planSync(local([meal(1), meal(2)], [sess(1)], 1), cloud([meal(1), meal(2)], [sess(1)], 0.5), base).pullVariety).toBe(0.5);
  });
});

describe("fingerprints", () => {
  it("a meal's fingerprint changes with dish or time, not with formatting of the same instant", () => {
    expect(mealHash(meal(1))).toBe(mealHash({ ...meal(1), consumedAt: "2026-11-06T20:00:00+08:00" }));
    expect(mealHash(meal(1))).not.toBe(mealHash(meal(1, "dish-chicken-pho")));
    expect(mealHash(meal(1))).not.toBe(mealHash(meal(1, "dish-bulalo", "2026-11-06T13:00:00.000Z")));
  });

  it("a session's fingerprint changes when a reaction is undone", () => {
    const s = sess(1);
    const undone = { ...s, exposures: [{ ...s.exposures[0]!, reaction: null, undoneReactions: ["yes" as const] }] };
    expect(sessionHash(s)).not.toBe(sessionHash(undone));
  });
});

describe("own described dishes (library step 2)", () => {
  const kebab = { cuisine: "middle_eastern", mains: ["beef"], method: "grilled", type: "wraps", flavors: ["flavor:garlicky"] };
  const reordered = { flavors: ["flavor:garlicky"], type: "wraps", method: "grilled", mains: ["beef"], cuisine: "middle_eastern" };

  it("a new description on this phone is pushed; the same description in another key order is not a change", () => {
    const base = ledgerAfter(U, local([meal(9, null)], []), "t");
    const described = { ...meal(9, null), ownDish: kebab };
    expect(planSync(local([described], []), cloud([meal(9, null)], []), base).pushMeals).toEqual([described]);
    const synced = ledgerAfter(U, local([described], []), "t2");
    const p = planSync(local([described], []), cloud([{ ...meal(9, null), ownDish: reordered as never }], []), synced);
    expect(p.pushMeals).toEqual([]);
    expect(p.pullMeals).toEqual([]);
  });

  it("pulls a description added on another device", () => {
    const base = ledgerAfter(U, local([meal(9, null)], []), "t");
    const p = planSync(local([meal(9, null)], []), cloud([{ ...meal(9, null), ownDish: kebab }], []), base);
    expect(p.pullMeals[0]?.ownDish).toEqual(kebab);
  });
});

describe("meal ratings (library step 3)", () => {
  it("a new rating on this phone is pushed; a rating made elsewhere is pulled", () => {
    const base = ledgerAfter(U, local([meal(5)], []), "t");
    const ratedHere = { ...meal(5), rating: 4 };
    expect(planSync(local([ratedHere], []), cloud([meal(5)], []), base).pushMeals).toEqual([ratedHere]);
    expect(planSync(local([meal(5)], []), cloud([{ ...meal(5), rating: 2 }], []), base).pullMeals[0]?.rating).toBe(2);
  });
});

describe("strong preferences (Love it / Not for a while / Never)", () => {
  const T = "2026-11-07T12:00:00.000Z";
  const fav: StrongPreference = { dishId: "dish-bulalo", kind: "favourite", at: T };
  const snz: StrongPreference = { dishId: "dish-dinuguan", kind: "snooze", at: T, until: "2026-12-07T12:00:00.000Z" };
  const withPrefs = (prefs: StrongPreference[]): LocalState => ({ ...local(), strongPrefs: prefs });
  const cloudPrefs = (prefs: StrongPreference[]): CloudState => ({ ...cloud(), strongPreferences: prefs });

  it("first sync pushes phone-only and pulls cloud-only preferences", () => {
    const p = planSync(withPrefs([fav]), cloudPrefs([snz]), null);
    expect(p.pushPrefs).toEqual([fav]);
    expect(p.pullPrefs).toEqual([snz]);
    expect(p.deleteCloudPrefs).toEqual([]);
  });

  it("removing one here deletes it in the cloud; removed elsewhere is removed here", () => {
    const base = ledgerAfter(U, withPrefs([fav, snz]), "t");
    const p = planSync(withPrefs([snz]), cloudPrefs([fav]), base);
    expect(p.deleteCloudPrefs).toEqual(["dish-bulalo"]);
    expect(p.removeLocalPrefs).toEqual(["dish-dinuguan"]);
  });

  it("a change here (snooze → never) is pushed; the same instant in another format is not a change", () => {
    const base = ledgerAfter(U, withPrefs([snz]), "t");
    const nev: StrongPreference = { dishId: "dish-dinuguan", kind: "never", at: "2026-11-07T12:05:00.000Z" };
    expect(planSync(withPrefs([nev]), cloudPrefs([snz]), base).pushPrefs).toEqual([nev]);
    const same = planSync(withPrefs([snz]), cloudPrefs([{ ...snz, at: "2026-11-07T20:00:00+08:00" }]), base);
    expect(same).toMatchObject({ pushPrefs: [], pullPrefs: [], deleteCloudPrefs: [], removeLocalPrefs: [] });
  });
});
