/**
 * Local-only prototype persistence (ENG-018, R-014, R-031).
 * Everything stays in this browser's localStorage/sessionStorage. Nothing is sent anywhere.
 * All access is wrapped so private mode / blocked storage degrades to in-memory behavior.
 */
import type { ConfirmedMeal, ReasonCode, RestrictionKey } from "@/engine";

const KEYS = {
  sessions: "fd.eval.sessions.v1",
  meals: "fd.meals.v1",
  assignment: "fd.eval.assignment.v1",
  restrictions: "fd.restrictions.session.v1",
} as const;

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
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

/* ---------------- evaluation records ---------------- */

export interface ExposureRecord {
  position: number;
  dishId: string;
  shownAt: string;
  selectionReason: string;
  q: number | null;
  selectionProbability: number;
  reaction: "yes" | "no" | null;
  /** A reaction that was given then undone. */
  undoneReactions: Array<"yes" | "no">;
  withdrawn: boolean;
}

export interface RecommendationRunRecord {
  at: string;
  trigger: "user_request" | "readiness_prompt" | "round_end" | "exhausted";
  kind: "tentative" | "ready";
  effectiveCards: number;
  eligibleCount: number;
  noMatch: boolean;
  inputDigest: string;
  items: Array<{ rank: number; dishId: string; appealScore: number; reasonCodes: ReasonCode[] }>;
}

export type OutcomeEvent =
  | { type: "dish_selected"; at: string; dishId: string; rank: number; runIndex: number }
  | { type: "recommendations_dismissed"; at: string; runIndex: number }
  | { type: "continued_discovery"; at: string }
  | { type: "meal_consumption_confirmed"; at: string; mealId: string; dishId: string | null; matchesSelection: boolean; unrecognized: boolean }
  | { type: "meal_not_logged"; at: string }
  | { type: "satisfaction_recorded"; at: string; mealId: string; rating: number };

export interface EvalSessionRecord {
  schemaVersion: 1;
  sessionId: string;
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

/* ---------------- policy assignment ---------------- */

export type AssignmentSetting = "rotation" | string;

export function getAssignmentSetting(): AssignmentSetting {
  return read<AssignmentSetting>(local, KEYS.assignment, "rotation");
}

export function setAssignmentSetting(v: AssignmentSetting): void {
  write(local, KEYS.assignment, v);
}

/* ---------------- dietary avoidances: this browser tab only ---------------- */

export function getRestrictions(): RestrictionKey[] {
  return read<RestrictionKey[]>(session, KEYS.restrictions, []);
}

export function setRestrictions(keys: RestrictionKey[]): void {
  write(session, KEYS.restrictions, keys);
}

/* ---------------- maintenance ---------------- */

export function clearAllLocalData(): void {
  try {
    for (const k of Object.values(KEYS)) {
      window.localStorage.removeItem(k);
      window.sessionStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
