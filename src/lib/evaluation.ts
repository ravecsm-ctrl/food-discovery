/**
 * Pure helpers that turn engine state into comparable evaluation records and summaries (ENG-018).
 * Kept free of browser APIs so they are unit-testable.
 */
import { ACTIVE_POLICY_IDS, type DiscoverySession, type RecommendationRun } from "@/engine";
import type { EvalSessionRecord, ExposureRecord, RecommendationRunRecord } from "./local-store";

export interface CardTrace {
  selectionReason: string;
  q: number | null;
}

export function exposureRecords(session: DiscoverySession, traces: Record<string, CardTrace>): ExposureRecord[] {
  return session.exposures.map((e) => {
    const forCard = session.reactions.filter((r) => r.exposureId === e.exposureId);
    const active = forCard.find((r) => r.active);
    const trace = traces[e.exposureId];
    return {
      position: e.position,
      dishId: e.dishId,
      shownAt: e.shownAt,
      selectionReason: trace?.selectionReason ?? "unknown",
      q: trace?.q ?? null,
      selectionProbability: e.selectionProbability,
      reaction: active?.value ?? null,
      undoneReactions: forCard.filter((r) => !r.active).map((r) => r.value),
      withdrawn: e.withdrawn,
    };
  });
}

export function runRecord(run: RecommendationRun, at: string, trigger: RecommendationRunRecord["trigger"]): RecommendationRunRecord {
  return {
    at,
    trigger,
    kind: run.kind,
    effectiveCards: run.effectiveCards,
    eligibleCount: run.eligibleCount,
    noMatch: run.noMatch,
    inputDigest: run.inputDigest,
    items: run.items.map((i) => ({ rank: i.rank, dishId: i.dishId, appealScore: i.appealScore, reasonCodes: i.reasonCodes })),
  };
}

/** Deterministic rotation across policies, based on how many sessions already exist. */
export function rotatePolicy(existingSessions: number): string {
  return ACTIVE_POLICY_IDS[existingSessions % ACTIVE_POLICY_IDS.length] as string;
}

export interface PolicySummary {
  policyId: string;
  sessions: number;
  sessionsWithResults: number;
  sessionsWithSelection: number;
  medianCardsToFirstResults: number | null;
  yesRate: number | null;
  mealsConfirmed: number;
  mealsMatchingSelection: number;
  ratings: number;
  meanRating: number | null;
  noMatchRuns: number;
  totalRuns: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** Per-policy summary. Every rate exposes its numerator and denominator (PRRD §16.2). */
export function summarize(records: EvalSessionRecord[]): PolicySummary[] {
  const ids = [...new Set([...ACTIVE_POLICY_IDS, ...records.map((r) => r.policyId)])];
  return ids.map((policyId) => {
    const rs = records.filter((r) => r.policyId === policyId);
    const withRuns = rs.filter((r) => r.recommendationRuns.length > 0);
    const reacted = rs.flatMap((r) => r.exposures.filter((e) => e.reaction));
    const meals = rs.flatMap((r) => r.events.filter((e) => e.type === "meal_consumption_confirmed"));
    const ratings = rs.flatMap((r) => r.events.filter((e) => e.type === "satisfaction_recorded"));
    const runs = rs.flatMap((r) => r.recommendationRuns);
    return {
      policyId,
      sessions: rs.length,
      sessionsWithResults: withRuns.length,
      sessionsWithSelection: rs.filter((r) => r.events.some((e) => e.type === "dish_selected")).length,
      medianCardsToFirstResults: median(withRuns.map((r) => (r.recommendationRuns[0] as RecommendationRunRecord).effectiveCards)),
      yesRate: reacted.length ? reacted.filter((e) => e.reaction === "yes").length / reacted.length : null,
      mealsConfirmed: meals.length,
      mealsMatchingSelection: meals.filter((m) => m.type === "meal_consumption_confirmed" && m.matchesSelection).length,
      ratings: ratings.length,
      meanRating: ratings.length
        ? ratings.reduce((a, e) => a + (e.type === "satisfaction_recorded" ? e.rating : 0), 0) / ratings.length
        : null,
      noMatchRuns: runs.filter((r) => r.noMatch).length,
      totalRuns: runs.length,
    };
  });
}

/** One CSV row per card exposure — easy to analyse in a spreadsheet. */
export function toCsv(records: EvalSessionRecord[]): string {
  const header = [
    "session_id", "policy_id", "catalog_version", "seed", "started_at", "hard_constraints_active",
    "position", "dish_id", "selection_reason", "q", "reaction", "undone_reactions", "withdrawn",
    "selected_dish_id", "meal_confirmed_dish_id", "satisfaction_rating",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = records.flatMap((r) => {
    const sel = [...r.events].reverse().find((e) => e.type === "dish_selected");
    const meal = [...r.events].reverse().find((e) => e.type === "meal_consumption_confirmed");
    const rating = [...r.events].reverse().find((e) => e.type === "satisfaction_recorded");
    return r.exposures.map((e) =>
      [
        r.sessionId, r.policyId, r.catalogVersion, r.seed, r.startedAt, r.hardConstraintsActive,
        e.position, e.dishId, e.selectionReason, e.q, e.reaction, e.undoneReactions.join("|"), e.withdrawn,
        sel?.type === "dish_selected" ? sel.dishId : "",
        meal?.type === "meal_consumption_confirmed" ? (meal.dishId ?? "unrecognized") : "",
        rating?.type === "satisfaction_recorded" ? rating.rating : "",
      ].map(esc).join(","),
    );
  });
  return [header.join(","), ...rows].join("\n");
}
