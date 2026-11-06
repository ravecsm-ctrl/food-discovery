/**
 * Shortlist generation, readiness, and grounded reason codes
 * (ENG-014, ENG-015; R-005, R-010, R-013; ETD §8.9, §8.11).
 */
import { buildCandidates, type EligibilityResult } from "./eligibility.ts";
import { dishFatigue, recentLoad, varietyEvidence, type RecentLoad } from "./fatigue.ts";
import { hashString } from "./rng.ts";
import { recentConfirmedMeals, scoreDish, type ScoreBreakdown } from "./scoring.ts";
import { scoringInputs, selectNextCard, type EngineDeps } from "./selection.ts";
import { activeReactions, effectiveCardCount, shownDishIds, type DiscoverySession } from "./session.ts";
import { dishSimilarity, sharedAttributes } from "./similarity.ts";
import type { Dish, FulfillmentStatus, ReasonCode, SafetyAssessment } from "./types.ts";
import { tieBreak } from "./rng.ts";
import { depsForSession, jointScore, participantUsers } from "./together.ts";

export interface RecommendationItem {
  rank: number;
  dishId: string;
  /** Internal model output — NOT a probability; never display as a percentage. */
  appealScore: number;
  fulfillmentStatus: FulfillmentStatus;
  safety: SafetyAssessment;
  reasonCodes: ReasonCode[];
  evidence: {
    /** `by` = which Together participant liked it; absent = a shared (or solo) like. */
    likedSimilar: Array<{ dishId: string; sharedAttributes: string[]; by?: "a" | "b" }>;
    recentMealsConsidered: number;
    /** Recently eaten qualities (e.g. "method:fried", "style:comfort") this dish is a change from. */
    varietyFrom: string[];
  };
  score: ScoreBreakdown;
}

export interface RecommendationRun {
  policyId: string;
  catalogVersion: string;
  kind: "tentative" | "ready";
  /** "quick_picks" = suggested from recent meals before any swiping. */
  source: "reactions" | "quick_picks";
  items: RecommendationItem[];
  noMatch: boolean;
  strongMatchAvailable: boolean;
  effectiveCards: number;
  excludedByConstraints: number;
  /** Run-level codes, e.g. HARD_CONSTRAINT_EXCLUDED, INSUFFICIENT_EVIDENCE. */
  runReasonCodes: ReasonCode[];
  inputDigest: string;
  eligibleCount: number;
}

export function inputDigest(session: DiscoverySession, deps: EngineDeps): string {
  const payload = JSON.stringify({
    p: deps.policy.id,
    c: deps.catalog.catalogVersion,
    s: session.seed,
    k: session.constraints,
    r: activeReactions(session).map((r) => [r.dishId, r.value, r.strength, r.participant ?? ""]),
    md: session.mode,
    tm: session.togetherMeals.map((m) => [m.id, m.dishId, m.consumedAt, m.who]),
    m: deps.user.confirmedMeals.map((m) => [m.id, m.dishId, m.consumedAt]),
    w: deps.user.stableAttributeWeights,
    n: deps.user.noveltyPreference,
    v: deps.user.varietySeeking ?? 1,
    t: deps.policy.exposure.enabled || deps.policy.fatigue.enabled ? deps.now : null,
  });
  return hashString(payload).toString(16).padStart(8, "0");
}

function reasonCodesFor(
  score: ScoreBreakdown,
  eligibility: EligibilityResult,
  deps: EngineDeps,
  recentDishIds: string[],
  tentative: boolean,
  varietyFrom: string[],
): ReasonCode[] {
  const r = deps.policy.reasons;
  const codes: ReasonCode[] = [];
  if (score.current >= r.currentPositiveMin && score.supportingLikes.length > 0) codes.push("CURRENT_SESSION_POSITIVE");
  if (score.stable >= r.stableMatchMin) codes.push("STABLE_PREFERENCE_MATCH");
  if (deps.policy.utilityWeights.novelty * score.novelty >= r.noveltyMin) codes.push("NOVELTY_EXPLORATION");
  if (deps.policy.fatigue.enabled) {
    if (varietyFrom.length > 0) codes.push("RECENT_FOOD_VARIETY");
  } else if (deps.policy.exposure.enabled && recentDishIds.length > 0) {
    let maxSim = 0;
    for (const id of recentDishIds) maxSim = Math.max(maxSim, dishSimilarity(deps.catalog, score.dishId, id, deps.policy.similarityKindWeights));
    if (maxSim <= r.varietyMaxSimilarityToRecent) codes.push("RECENT_FOOD_VARIETY");
  }
  if (eligibility.fulfillment !== "verified") codes.push("FULFILLMENT_UNVERIFIED");
  if (tentative) codes.push("INSUFFICIENT_EVIDENCE");
  return codes;
}

/** Produce 0–3 diverse, evidence-backed recommendations. Zero items is a valid no-match result. */
export function recommend(session: DiscoverySession, deps: EngineDeps): RecommendationRun {
  deps = depsForSession(session, deps);
  const together = session.mode === "together";
  const cfg = deps.policy.shortlist;
  const candidates = buildCandidates(deps.catalog, session.constraints);
  const inputs = scoringInputs(session, deps);
  const users = together ? participantUsers(session) : undefined;
  // "Not tonight" removes a dish for this session. In Together Mode only a SHARED No does; a dish one
  // person wanted stays a candidate and the joint score decides (ETD §8.10).
  const rejectedNow = new Set(inputs.reactions.filter((x) => x.value === "no" && !x.participant).map((x) => x.dishId));

  const scored = candidates.eligible
    .filter((d) => !rejectedNow.has(d.id))
    .map((d) => ({ dish: d, score: together ? jointScore(d, inputs, users) : scoreDish(d, inputs) }))
    .sort(
      (a, b) =>
        b.score.utility - a.score.utility ||
        tieBreak(session.seed, b.dish.id) - tieBreak(session.seed, a.dish.id),
    );

  const plausible = scored.filter(
    ({ score }) =>
      score.utility >= cfg.minUtility && Math.max(score.current, score.stable, score.softContext) >= cfg.minPositiveEvidence,
  );

  const picked: Array<{ dish: Dish; score: ScoreBreakdown }> = [];
  for (const c of plausible) {
    if (picked.length >= cfg.maxItems) break;
    const nearDuplicate = picked.some(
      (p) => dishSimilarity(deps.catalog, p.dish.id, c.dish.id, deps.policy.similarityKindWeights) >= cfg.nearDuplicateSimilarity,
    );
    if (!nearDuplicate) picked.push(c);
  }

  const effective = effectiveCardCount(session);
  const strongMatchAvailable = picked.some((p) => p.score.utility >= cfg.strongMatchUtility);
  const tentative = effective < deps.policy.reasons.minReactionsForEvidence || !strongMatchAvailable;
  const recent = deps.policy.exposure.enabled
    ? recentConfirmedMeals(deps.user.confirmedMeals, deps.now, deps.policy.exposure.windowDays)
    : deps.policy.fatigue.enabled
      ? recentConfirmedMeals(deps.user.confirmedMeals, deps.now, deps.policy.fatigue.windowDays)
      : [];
  const load = deps.policy.fatigue.enabled ? recentLoad(deps.catalog, deps.user.confirmedMeals, deps.now, deps.policy.fatigue) : null;
  const recentDishIds = recent.map((m) => m.dishId).filter((x): x is string => !!x && deps.catalog.byId.has(x));

  const items: RecommendationItem[] = picked.map(({ dish, score }, i) => {
    const eligibility = candidates.byId.get(dish.id) as EligibilityResult;
    const varietyFrom = freshVarietyFrom(dish, load, deps);
    return {
      rank: i + 1,
      dishId: dish.id,
      appealScore: Math.round(score.utility * 1000) / 1000,
      fulfillmentStatus: eligibility.fulfillment,
      safety: eligibility.safety,
      reasonCodes: togetherCodes(reasonCodesFor(score, eligibility, deps, recentDishIds, tentative, varietyFrom), score, together),
      evidence: {
        likedSimilar: score.supportingLikes.slice(0, 2).map((s) => ({
          dishId: s.dishId,
          sharedAttributes: sharedAttributes(dish, deps.catalog.byId.get(s.dishId) as Dish),
          ...(s.by ? { by: s.by } : {}),
        })),
        recentMealsConsidered: recent.length,
        varietyFrom,
      },
      score,
    };
  });

  const runReasonCodes: ReasonCode[] = [];
  if (candidates.excluded.length > 0) runReasonCodes.push("HARD_CONSTRAINT_EXCLUDED");
  if (tentative) runReasonCodes.push("INSUFFICIENT_EVIDENCE");

  return {
    policyId: deps.policy.id,
    catalogVersion: deps.catalog.catalogVersion,
    kind: tentative ? "tentative" : "ready",
    source: "reactions",
    items,
    noMatch: items.length === 0,
    strongMatchAvailable,
    effectiveCards: effective,
    excludedByConstraints: candidates.excluded.length,
    runReasonCodes,
    inputDigest: inputDigest(session, deps),
    eligibleCount: candidates.eligible.length,
  };
}

/** In Together Mode, a like that both people gave together is a SHARED_SESSION_POSITIVE (R-011). */
function togetherCodes(codes: ReasonCode[], score: ScoreBreakdown, together: boolean): ReasonCode[] {
  if (!together) return codes;
  const top = score.supportingLikes[0];
  return codes.map((c) => (c === "CURRENT_SESSION_POSITIVE" && top && !top.by ? "SHARED_SESSION_POSITIVE" : c));
}

/** Variety evidence only for dishes that are genuinely a fresh change (low fatigue). */
function freshVarietyFrom(dish: Dish, load: RecentLoad | null, deps: EngineDeps): string[] {
  if (!load || load.mealsInWindow === 0) return [];
  if (dishFatigue(dish, load, deps.policy.fatigue) > deps.policy.fatigue.freshMax) return [];
  return varietyEvidence(dish, load, deps.policy.fatigue);
}

/**
 * Quick picks (D-10): up to 3 suggestions from recent confirmed meals alone, before any swiping.
 * Ranked by freshness (1 − fatigue) and recognizability, kept diverse, and always labelled tentative.
 * Returns an explicit no-match when there are no recent meals (nothing to base picks on).
 */
export function quickPicks(session: DiscoverySession, deps: EngineDeps): RecommendationRun {
  const cfg = deps.policy.fatigue;
  const candidates = buildCandidates(deps.catalog, session.constraints);
  const load = recentLoad(deps.catalog, deps.user.confirmedMeals, deps.now, cfg);
  const recent = recentConfirmedMeals(deps.user.confirmedMeals, deps.now, cfg.windowDays);
  const eatenRecently = new Set(recent.map((m) => m.dishId).filter((x): x is string => !!x));
  const inputs = scoringInputs(session, deps);
  const runReasonCodes: ReasonCode[] = ["INSUFFICIENT_EVIDENCE"];
  if (candidates.excluded.length > 0) runReasonCodes.unshift("HARD_CONSTRAINT_EXCLUDED");
  const base = {
    policyId: deps.policy.id,
    catalogVersion: deps.catalog.catalogVersion,
    kind: "tentative" as const,
    source: "quick_picks" as const,
    strongMatchAvailable: false,
    effectiveCards: 0,
    excludedByConstraints: candidates.excluded.length,
    runReasonCodes,
    inputDigest: inputDigest(session, deps),
    eligibleCount: candidates.eligible.length,
  };
  // Picks must be grounded in recognized meals; free-text-only history gives no attribute evidence.
  if (!cfg.enabled || load.load.size === 0) return { ...base, items: [], noMatch: true };

  const ranked = candidates.eligible
    .filter((d) => !eatenRecently.has(d.id))
    .map((d) => {
      const fatigue = dishFatigue(d, load, cfg);
      return { d, fatigue, pick: 0.65 * (1 - fatigue) + 0.35 * d.recognizability };
    })
    .filter((x) => x.fatigue <= cfg.freshMax)
    .sort((a, b) => b.pick - a.pick || tieBreak(session.seed, b.d.id) - tieBreak(session.seed, a.d.id));

  const picked: typeof ranked = [];
  for (const pass of [true, false]) {
    for (const c of ranked) {
      if (picked.length >= 3) break;
      if (picked.includes(c)) continue;
      const tooSimilar = picked.some((p) => dishSimilarity(deps.catalog, p.d.id, c.d.id, deps.policy.similarityKindWeights) >= 0.6);
      const sameStyle = picked.some((p) => p.d.style === c.d.style);
      if (tooSimilar || (pass && sameStyle)) continue;
      picked.push(c);
    }
  }

  const items: RecommendationItem[] = picked.map(({ d }, i) => {
    const eligibility = candidates.byId.get(d.id) as EligibilityResult;
    const varietyFrom = varietyEvidence(d, load, cfg);
    const score = scoreDish(d, inputs);
    const reasonCodes: ReasonCode[] = [];
    if (varietyFrom.length > 0) reasonCodes.push("RECENT_FOOD_VARIETY");
    reasonCodes.push("FULFILLMENT_UNVERIFIED", "INSUFFICIENT_EVIDENCE");
    return {
      rank: i + 1,
      dishId: d.id,
      appealScore: Math.round(score.utility * 1000) / 1000,
      fulfillmentStatus: eligibility.fulfillment,
      safety: eligibility.safety,
      reasonCodes,
      evidence: { likedSimilar: [], recentMealsConsidered: recent.length, varietyFrom },
      score,
    };
  });
  return { ...base, items, noMatch: items.length === 0 };
}

export interface Readiness {
  effectiveCards: number;
  /** Users may always ask for (possibly empty, tentative) results once they have reacted. */
  canRequestResults: boolean;
  /** Offer a non-blocking "see your picks" prompt (≥3 cards, a plausible pick, enough variety). */
  promptReady: boolean;
  roundComplete: boolean;
  exhausted: boolean;
}

export function readiness(session: DiscoverySession, deps: EngineDeps): Readiness {
  deps = depsForSession(session, deps);
  const effective = effectiveCardCount(session);
  const exhausted = selectNextCard(session, deps) === null;
  let promptReady = false;
  if (effective >= deps.policy.session.minCardsForReadinessPrompt) {
    const structures = new Set<string>();
    for (const id of shownDishIds(session)) {
      const d = deps.catalog.byId.get(id);
      const s = d && Object.keys(d.attributes).find((k) => k.startsWith("structure:"));
      if (s) structures.add(s);
    }
    promptReady = structures.size >= 3 && recommend(session, deps).items.length > 0;
  }
  return {
    effectiveCards: effective,
    canRequestResults: effective >= 1,
    promptReady,
    roundComplete: effective >= session.roundEndsAt,
    exhausted,
  };
}
