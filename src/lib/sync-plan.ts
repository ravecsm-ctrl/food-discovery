/**
 * Pure three-way reconciliation between this device and the person's cloud copy (ENG-023, ENG-025,
 * R-015, R-029). "base" is what both sides agreed on at the last successful sync (the ledger), so we
 * can tell a deletion on one side from a creation on the other.
 *
 * Rules (per item):
 *   only on device  → new here: push · (was synced before → deleted elsewhere: remove here)
 *   only in cloud   → new elsewhere: pull · (was synced before → deleted here: delete in cloud)
 *   on both, differ → whichever side still matches base is stale; if both changed, this device wins.
 * Sessions are append-only and never deleted by sync. Dietary restrictions are never involved.
 */
import { cleanOwnDish, type ConfirmedMeal } from "@/engine";
import type { EvalSessionRecord } from "./local-store";

export interface SyncLedger {
  userId: string;
  meals: Record<string, string>;
  sessions: Record<string, string>;
  varietySeeking?: number;
  lastSyncedAt?: string;
}

export interface CloudSession extends EvalSessionRecord {
  version: number;
}

export interface CloudState {
  consent: boolean;
  profile: { varietySeeking: number } | null;
  meals: Array<ConfirmedMeal & { sourceSessionId?: string | null }>;
  sessions: CloudSession[];
}

export interface LocalState {
  meals: ConfirmedMeal[];
  sessions: EvalSessionRecord[];
  varietySeeking: number;
}

export interface SyncPlan {
  pushMeals: ConfirmedMeal[];
  deleteCloudMeals: string[];
  pullMeals: ConfirmedMeal[];
  removeLocalMeals: string[];
  pushSessions: Array<{ record: EvalSessionRecord; expectedVersion: number }>;
  pullSessions: EvalSessionRecord[];
  pushVariety: number | null;
  pullVariety: number | null;
  skipped: { sessions: number; meals: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const ms = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : String(t);
};

/** Content fingerprint of a meal (what a correction can change). */
export function mealHash(m: ConfirmedMeal): string {
  // Canonical field order: the database may return JSON keys in a different order.
  const own = m.dishId ? "" : JSON.stringify(cleanOwnDish(m.ownDish) ?? "");
  return fnv([m.dishId ?? "", m.dishId ? "" : (m.unrecognizedName ?? "").trim(), ms(m.consumedAt), m.timeApprox ? 1 : 0, own].join("|"));
}

/** Content fingerprint of a session: the parts that only grow, ignoring float precision and timestamps of sync. */
export function sessionHash(s: EvalSessionRecord): string {
  return fnv(
    JSON.stringify([
      s.exposures.map((e) => [e.position, e.dishId, e.reaction, e.undoneReactions, e.withdrawn]),
      s.recommendationRuns.map((r) => r.inputDigest),
      s.events.map((e) => [e.type, ms(e.at)]),
    ]),
  );
}

/** Which local records can live in the cloud at all. */
export function syncableMeal(m: ConfirmedMeal): boolean {
  return isUuid(m.id) && m.source !== "synthetic" && (m.dishId !== null || !!m.unrecognizedName?.trim());
}
export function syncableSession(s: EvalSessionRecord): boolean {
  return isUuid(s.sessionId);
}

export function planSync(local: LocalState, cloud: CloudState, base: SyncLedger | null): SyncPlan {
  const plan: SyncPlan = {
    pushMeals: [],
    deleteCloudMeals: [],
    pullMeals: [],
    removeLocalMeals: [],
    pushSessions: [],
    pullSessions: [],
    pushVariety: null,
    pullVariety: null,
    skipped: { sessions: 0, meals: 0 },
  };
  const baseMeals = base?.meals ?? {};
  const baseSessions = base?.sessions ?? {};

  /* meals */
  const localMeals = new Map<string, ConfirmedMeal>();
  for (const m of local.meals) {
    if (syncableMeal(m)) localMeals.set(m.id, m);
    else plan.skipped.meals++;
  }
  const cloudMeals = new Map(cloud.meals.map((m) => [m.id, m]));
  for (const id of new Set([...localMeals.keys(), ...cloudMeals.keys()])) {
    const l = localMeals.get(id);
    const c = cloudMeals.get(id);
    const b = baseMeals[id];
    if (l && !c) {
      if (b) plan.removeLocalMeals.push(id);
      else plan.pushMeals.push(l);
    } else if (!l && c) {
      if (b) plan.deleteCloudMeals.push(id);
      else plan.pullMeals.push(stripCloudMeal(c));
    } else if (l && c) {
      const lh = mealHash(l);
      const ch = mealHash(c);
      if (lh === ch) continue;
      if (lh === b) plan.pullMeals.push(stripCloudMeal(c));
      else plan.pushMeals.push(l);
    }
  }

  /* sessions (append-only) */
  const localSessions = new Map<string, EvalSessionRecord>();
  for (const s of local.sessions) {
    if (syncableSession(s)) localSessions.set(s.sessionId, s);
    else plan.skipped.sessions++;
  }
  const cloudSessions = new Map(cloud.sessions.map((s) => [s.sessionId, s]));
  for (const id of new Set([...localSessions.keys(), ...cloudSessions.keys()])) {
    const l = localSessions.get(id);
    const c = cloudSessions.get(id);
    if (l && !c) plan.pushSessions.push({ record: l, expectedVersion: 0 });
    else if (!l && c) plan.pullSessions.push(stripCloudSession(c));
    else if (l && c) {
      const lh = sessionHash(l);
      const ch = sessionHash(c);
      if (lh === ch) continue;
      if (lh === baseSessions[id] && ch !== baseSessions[id]) plan.pullSessions.push(stripCloudSession(c));
      else plan.pushSessions.push({ record: l, expectedVersion: c.version });
    }
  }

  /* preferences */
  const cv = cloud.profile?.varietySeeking;
  const lv = local.varietySeeking;
  if (cv === undefined || cv === null) {
    if (lv !== 1) plan.pushVariety = lv;
  } else if (Math.abs(cv - lv) > 1e-6) {
    if (base?.varietySeeking !== undefined && Math.abs(base.varietySeeking - lv) < 1e-6) plan.pullVariety = cv;
    else plan.pushVariety = lv;
  }
  return plan;
}

function stripCloudMeal(m: ConfirmedMeal & { sourceSessionId?: string | null }): ConfirmedMeal {
  return {
    id: m.id,
    dishId: m.dishId,
    unrecognizedName: m.dishId ? null : (m.unrecognizedName ?? null),
    consumedAt: m.consumedAt,
    confirmed: true,
    source: m.source,
    timeApprox: m.timeApprox ?? false,
    ...(m.dishId || !cleanOwnDish(m.ownDish) ? {} : { ownDish: cleanOwnDish(m.ownDish) }),
  };
}

function stripCloudSession(s: CloudSession): EvalSessionRecord {
  const rest: Partial<CloudSession> = { ...s };
  delete rest.version;
  return rest as EvalSessionRecord;
}

/** Ledger after a fully successful sync: what both sides now hold. */
export function ledgerAfter(userId: string, local: LocalState, at: string): SyncLedger {
  return {
    userId,
    meals: Object.fromEntries(local.meals.filter(syncableMeal).map((m) => [m.id, mealHash(m)])),
    sessions: Object.fromEntries(local.sessions.filter(syncableSession).map((s) => [s.sessionId, sessionHash(s)])),
    varietySeeking: local.varietySeeking,
    lastSyncedAt: at,
  };
}
