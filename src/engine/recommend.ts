/**
 * Shortlist generation, readiness, and grounded reason codes
 * (ENG-014, ENG-015; R-005, R-010, R-013; ETD §8.9, §8.11).
 */
import { buildCandidates, type EligibilityResult } from "./eligibility.ts";
import { hashString } from "./rng.ts";
import { recentConfirmedMeals, scoreDish, type ScoreBreakdown } from "./scoring.ts";
import { scoringInputs, selectNextCard, type EngineDeps } from "./selection.ts";
import { activeReactions, effectiveCardCount, shownDishIds, type DiscoverySession } from "./session.ts";
import { dishSimilarity, sharedAttributes } from "./similarity.ts";
import type { Dish, FulfillmentStatus, ReasonCode, SafetyAssessment } from "./types.ts";
import { tieBreak } from "./rng.ts";

export interface RecommendationItem {
  rank: number;
  dishId: string;
  /** Internal model output — NOT a probability; never display as a percentage. */
  appealScore: number;
  fulfillmentStatus: FulfillmentStatus;
  safety: SafetyAssessment;
  reasonCodes: ReasonCode[];
  evidence: {
    likedSimilar: Array<{ dishId: string; sharedAttributes: string[] }>;
    recentMealsConsidered: number;
  };
  score: ScoreBreakdown;
}

export interface RecommendationRun {
  policyId: string;
  catalogVersion: string;
  kind: "tentative" | "ready";
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
    r: activeReactions(session).map((r) => [r.dishId, r.value, r.strength]),
    m: deps.user.confirmedMeals.map((m) => [m.id, m.dishId, m.consumedAt]),
    w: deps.user.stableAttributeWeights,
    n: deps.user.noveltyPreference,
    t: deps.policy.exposure.enabled ? deps.now : null,
  });
  return hashString(payload).toString(16).padStart(8, "0");
}

function reasonCodesFor(
  score: ScoreBreakdown,
  eligibility: EligibilityResult,
  deps: EngineDeps,
  recentDishIds: string[],
  tentative: boolean,
): ReasonCode[] {
  const r = deps.policy.reasons;
  const codes: ReasonCode[] = [];
  if (score.current >= r.currentPositiveMin && score.supportingLikes.length > 0) codes.push("CURRENT_SESSION_POSITIVE");
  if (score.stable >= r.stableMatchMin) codes.push("STABLE_PREFERENCE_MATCH");
  if (deps.policy.utilityWeights.novelty * score.novelty >= r.noveltyMin) codes.push("NOVELTY_EXPLORATION");
  if (deps.policy.exposure.enabled && recentDishIds.length > 0) {
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
  const cfg = deps.policy.shortlist;
  const candidates = buildCandidates(deps.catalog, session.constraints);
  const inputs = scoringInputs(session, deps);
  const rejectedNow = new Set(inputs.reactions.filter((x) => x.value === "no").map((x) => x.dishId));

  const scored = candidates.eligible
    .filter((d) => !rejectedNow.has(d.id))
    .map((d) => ({ dish: d, score: scoreDish(d, inputs) }))
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
    : [];
  const recentDishIds = recent.map((m) => m.dishId).filter((x): x is string => !!x && deps.catalog.byId.has(x));

  const items: RecommendationItem[] = picked.map(({ dish, score }, i) => {
    const eligibility = candidates.byId.get(dish.id) as EligibilityResult;
    return {
      rank: i + 1,
      dishId: dish.id,
      appealScore: Math.round(score.utility * 1000) / 1000,
      fulfillmentStatus: eligibility.fulfillment,
      safety: eligibility.safety,
      reasonCodes: reasonCodesFor(score, eligibility, deps, recentDishIds, tentative),
      evidence: {
        likedSimilar: score.supportingLikes.slice(0, 2).map((s) => ({
          dishId: s.dishId,
          sharedAttributes: sharedAttributes(dish, deps.catalog.byId.get(s.dishId) as Dish),
        })),
        recentMealsConsidered: recent.length,
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
