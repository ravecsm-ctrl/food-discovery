/**
 * On-device persistence (ENG-018, R-014, R-031, R-015).
 * Data lives in this browser's localStorage. The only thing that ever leaves the device is the
 * optional one-way backup to the person's own private GitHub repo (see cloud-backup.ts).
 * All access is wrapped so private mode / blocked storage degrades to in-memory behavior.
 */
import type { ConfirmedMeal, ReasonCode, RestrictionKey, StrongPreference } from "@/engine";

const KEYS = {
  sessions: "fd.eval.sessions.v1",
  meals: "fd.meals.v1",
  assignment: "fd.eval.assignment.v1",
  /** Remembered on this device only (owner decision 2026-11-06). Never backed up or exported. */
  restrictions: "fd.restrictions.device.v1",
  /** Previous per-tab key, read once for migration. */
  restrictionsLegacy: "fd.restrictions.session.v1",
  profile: "fd.profile.v1",
  /** "Love it" / "Not for a while" / "Never show again" (strong-prefs.ts). */
  strongPrefs: "fd.strongprefs.v1",
} as const;

/** Keys whose content is part of the personal backup (never the cloud token, never restrictions). */
const BACKED_UP = new Set<string>([KEYS.sessions, KEYS.meals, KEYS.assignment, KEYS.profile, KEYS.strongPrefs]);

type Listener = () => void;
const listeners = new Set<Listener>();
let muted = false;
/** Called after any change to backed-up data (used to schedule the cloud backup). */
export function onDataChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function changed(key: string) {
  if (muted || !BACKED_UP.has(key)) return;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function read<T>(storage: () => Storage, key: string, fallback: T): T {
  try {
    const raw = storage().getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — prototype continues in memory */
  }
  changed(key);
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/* ---------------- evaluation records ---------------- */

/**
 * "yes"/"no" = one (shared) reaction · "a"/"b" = Together disagreement: only that person wanted it ·
 * "super_yes"/"super_no" = solo "Love it" / "Not for a while" (explicit strength).
 */
export type ReactionCode = "yes" | "no" | "a" | "b" | "super_yes" | "super_no";

export interface ExposureRecord {
  position: number;
  dishId: string;
  shownAt: string;
  selectionReason: string;
  q: number | null;
  selectionProbability: number;
  reaction: ReactionCode | null;
  /** A reaction that was given then undone. */
  undoneReactions: ReactionCode[];
  withdrawn: boolean;
}

export interface RecommendationRunRecord {
  at: string;
  trigger: "quick_picks" | "user_request" | "readiness_prompt" | "round_end" | "exhausted";
  kind: "tentative" | "ready";
  effectiveCards: number;
  eligibleCount: number;
  noMatch: boolean;
  inputDigest: string;
  items: Array<{ rank: number; dishId: string; appealScore: number; reasonCodes: ReasonCode[] }>;
}

export type OutcomeEvent =
  | { type: "dish_selected"; at: string; dishId: string; rank: number; runIndex: number }
  /** Together Mode: one explicit shared confirmation on a shared screen (PRRD J-03 step 7) — not proof of two accounts' consent. */
  | { type: "joint_decision_confirmed"; at: string; dishId: string; rank: number; runIndex: number }
  | { type: "recommendations_dismissed"; at: string; runIndex: number }
  | { type: "continued_discovery"; at: string }
  | { type: "meal_consumption_confirmed"; at: string; mealId: string; dishId: string | null; matchesSelection: boolean; unrecognized: boolean }
  | { type: "meal_not_logged"; at: string }
  | { type: "satisfaction_recorded"; at: string; mealId: string; rating: number };

export interface EvalSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  /** Absent = solo. Participant names are never stored. */
  mode?: "together";
  policyId: string;
  assignment: "rotation" | "manual";
  catalogVersion: string;
  seed: number;
  startedAt: string;
  updatedAt: string;
  /** Privacy: only whether avoidances were active, never which ones (AT-033). */
  hardConstraintsActive: boolean;
  excludedByConstraints: number;
  exposures: ExposureRecord[];
  recommendationRuns: RecommendationRunRecord[];
  events: OutcomeEvent[];
}

export function listEvalSessions(): EvalSessionRecord[] {
  return read<EvalSessionRecord[]>(local, KEYS.sessions, []);
}

export function upsertEvalSession(rec: EvalSessionRecord): void {
  const all = listEvalSessions().filter((s) => s.sessionId !== rec.sessionId);
  write(local, KEYS.sessions, [...all, rec]);
}

export function appendEvalEvent(sessionId: string, event: OutcomeEvent): void {
  const all = listEvalSessions();
  const rec = all.find((s) => s.sessionId === sessionId);
  if (!rec) return;
  rec.events.push(event);
  rec.updatedAt = event.at;
  write(local, KEYS.sessions, all);
}

/* ---------------- confirmed meals (food memory) ---------------- */

export function listMeals(): ConfirmedMeal[] {
  return read<ConfirmedMeal[]>(local, KEYS.meals, []);
}

export function addMeal(meal: ConfirmedMeal): void {
  write(local, KEYS.meals, [...listMeals().filter((m) => m.id !== meal.id), meal]);
}

export function removeMeal(id: string): void {
  write(local, KEYS.meals, listMeals().filter((m) => m.id !== id));
}

/** Correct a logged meal (R-015). Taste fatigue is recomputed from meals on every use, so it updates at once (ENG-026). */
export function updateMeal(id: string, patch: Partial<Pick<ConfirmedMeal, "dishId" | "unrecognizedName" | "consumedAt" | "timeApprox" | "ownDish" | "rating">>): void {
  write(
    local,
    KEYS.meals,
    listMeals().map((m) => {
      if (m.id !== id) return m;
      const next = { ...m, ...patch };
      if (next.dishId) {
        next.unrecognizedName = null;
        next.ownDish = null; // a listed dish describes itself
      }
      return next;
    }),
  );
}

/* ---------------- strong preferences (one per dish) ---------------- */

export function listStrongPrefs(): StrongPreference[] {
  return read<StrongPreference[]>(local, KEYS.strongPrefs, []);
}

export function getStrongPref(dishId: string): StrongPreference | null {
  return listStrongPrefs().find((p) => p.dishId === dishId) ?? null;
}

/** Save (or replace) the preference for a dish; `null` removes it. */
export function setStrongPref(dishId: string, pref: StrongPreference | null): void {
  write(local, KEYS.strongPrefs, [...listStrongPrefs().filter((p) => p.dishId !== dishId), ...(pref ? [pref] : [])]);
}

/** Apply changes that arrived from the person's cloud copy (merge, never wholesale replace). */
export function applyCloudChanges(c: {
  upsertMeals: ConfirmedMeal[];
  removeMeals: string[];
  upsertSessions: EvalSessionRecord[];
  varietySeeking: number | null;
  upsertPrefs?: StrongPreference[];
  removePrefs?: string[];
}): void {
  if (c.upsertPrefs?.length || c.removePrefs?.length) {
    const drop = new Set([...(c.removePrefs ?? []), ...(c.upsertPrefs ?? []).map((p) => p.dishId)]);
    write(local, KEYS.strongPrefs, [...listStrongPrefs().filter((p) => !drop.has(p.dishId)), ...(c.upsertPrefs ?? [])]);
  }
  if (c.upsertMeals.length || c.removeMeals.length) {
    const drop = new Set([...c.removeMeals, ...c.upsertMeals.map((m) => m.id)]);
    write(local, KEYS.meals, [...listMeals().filter((m) => !drop.has(m.id)), ...c.upsertMeals]);
  }
  if (c.upsertSessions.length) {
    const ids = new Set(c.upsertSessions.map((s) => s.sessionId));
    write(local, KEYS.sessions, [...listEvalSessions().filter((s) => !ids.has(s.sessionId)), ...c.upsertSessions]);
  }
  if (c.varietySeeking !== null) write(local, KEYS.profile, { ...getProfile(), varietySeeking: c.varietySeeking });
}

/* ---------------- policy assignment ---------------- */

export type AssignmentSetting = "rotation" | string;

export function getAssignmentSetting(): AssignmentSetting {
  return read<AssignmentSetting>(local, KEYS.assignment, "rotation");
}

export function setAssignmentSetting(v: AssignmentSetting): void {
  write(local, KEYS.assignment, v);
}

/* ---------------- dietary avoidances: remembered on this device, never backed up ---------------- */

export function getRestrictions(): RestrictionKey[] {
  const saved = read<RestrictionKey[] | null>(local, KEYS.restrictions, null);
  if (saved) return saved;
  return read<RestrictionKey[]>(session, KEYS.restrictionsLegacy, []);
}

export function setRestrictions(keys: RestrictionKey[]): void {
  write(local, KEYS.restrictions, keys);
  try {
    window.sessionStorage.removeItem(KEYS.restrictionsLegacy);
  } catch {
    /* ignore */
  }
}

/* ---------------- taste profile ---------------- */

export interface Profile {
  /** 0.5 routine · 1 normal · 1.5 gets bored quickly (taste-fatigue strength). */
  varietySeeking: number;
  /** When the recent-meals question was last answered or skipped. */
  recentMealsAskedAt?: string;
}

export function getProfile(): Profile {
  return { varietySeeking: 1, ...read<Partial<Profile>>(local, KEYS.profile, {}) };
}

export function setProfile(patch: Partial<Profile>): void {
  write(local, KEYS.profile, { ...getProfile(), ...patch });
}

/* ---------------- backup snapshot ---------------- */

export interface BackupData {
  sessions: EvalSessionRecord[];
  meals: ConfirmedMeal[];
  assignment: AssignmentSetting;
  profile: Profile;
  strongPrefs?: StrongPreference[];
}

export function snapshot(): BackupData {
  return { sessions: listEvalSessions(), meals: listMeals(), assignment: getAssignmentSetting(), profile: getProfile(), strongPrefs: listStrongPrefs() };
}

/** Replace all backed-up data (restore). Does not trigger a new backup by itself. */
export function replaceAll(data: BackupData): void {
  muted = true;
  try {
    write(local, KEYS.sessions, data.sessions);
    write(local, KEYS.meals, data.meals);
    write(local, KEYS.assignment, data.assignment);
    write(local, KEYS.profile, data.profile);
    if (data.strongPrefs) write(local, KEYS.strongPrefs, data.strongPrefs);
  } finally {
    muted = false;
  }
}

export function hasLocalData(): boolean {
  return listEvalSessions().length > 0 || listMeals().length > 0 || listStrongPrefs().length > 0;
}

/* ---------------- maintenance ---------------- */

/** Clears data on this device. Callers must disconnect cloud backup first so an empty copy never overwrites it. */
export function clearAllLocalData(): void {
  muted = true;
  try {
    for (const k of Object.values(KEYS)) {
      window.localStorage.removeItem(k);
      window.sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  } finally {
    muted = false;
  }
}
