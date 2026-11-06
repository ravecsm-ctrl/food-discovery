/**
 * Preference scoring (ENG-010, ENG-011, R-008, R-012, ETD §8.3–§8.6).
 *
 * Signals are kept separate and inspectable:
 *   P stable preference, C current appetite, X soft context, N novelty, R exposure adjustment.
 * Scores are NOT probabilities and must never be shown as percentages.
 */
import { clamp, dishSimilarity } from "./similarity.ts";
import type { PolicyConfig } from "./policy.ts";
import type { Catalog, ConfirmedMeal, Dish, Reaction, UserModel } from "./types.ts";

export interface ScoreBreakdown {
  dishId: string;
  stable: number;
  current: number;
  /** Amount of relevant current-session evidence behind `current`, 0..1. */
  currentEvidence: number;
  softContext: number;
  novelty: number;
  /** Raw exposure E (0..cap) and resulting adjustment R (≤ 0). */
  exposure: number;
  exposureAdjustment: number;
  utility: number;
  /** Positively reacted dishes that meaningfully support this dish (for grounded reasons). */
  supportingLikes: Array<{ dishId: string; similarity: number }>;
}

export interface ScoringInputs {
  catalog: Catalog;
  policy: PolicyConfig;
  user: UserModel;
  softAttributeWeights: Record<string, number>;
  /** Only ACTIVE reactions are considered. Invalidated reactions have no effect. */
  reactions: readonly Reaction[];
  now: string;
}

/** Weighted alignment between a weight map (-1..1) and dish attributes (0..1); 0 when no weights. */
export function weightAlignment(weights: Record<string, number>, dish: Dish): number {
  let num = 0;
  let den = 0;
  for (const [attr, w] of Object.entries(weights)) {
    if (w === 0) continue;
    den += Math.abs(w);
    const x = attr.startsWith("cuisine:") ? (attr === `cuisine:${dish.cuisine}` ? 1 : 0) : (dish.attributes[attr] ?? 0);
    num += clamp(w, -1, 1) * x;
  }
  return den === 0 ? 0 : clamp(num / den, -1, 1);
}

function reactionWeight(r: Reaction, policy: PolicyConfig): number {
  const { ordinary, explicit, explicitCap } = policy.reactionWeights;
  const mag = r.strength === "explicit" ? Math.min(explicit, explicitCap) : ordinary;
  return r.value === "yes" ? mag : -mag;
}

/** ETD §8.4 current appetite C(u,d) ∈ [-1,1]. 0 when there are no active reactions. */
export function currentAppetite(
  dishId: string,
  inputs: ScoringInputs,
): { value: number; evidence: number; supportingLikes: ScoreBreakdown["supportingLikes"] } {
  const { policy, catalog } = inputs;
  const cfg = policy.currentAppetite;
  let num = 0;
  let den = 0;
  let mass = 0;
  const supportingLikes: ScoreBreakdown["supportingLikes"] = [];
  for (const r of inputs.reactions) {
    if (!r.active) continue;
    const w = reactionWeight(r, policy);
    const sim = dishSimilarity(catalog, dishId, r.dishId, policy.similarityKindWeights);
    if (r.value === "yes" && sim >= policy.reasons.supportingSimilarityMin) {
      supportingLikes.push({ dishId: r.dishId, similarity: sim });
    }
    if (cfg.normalization === "global") {
      num += w * sim;
      den += Math.abs(w);
      mass += Math.abs(w) * sim;
    } else {
      const k = Math.max(0, (sim - cfg.similarityFloor) / (1 - cfg.similarityFloor)) ** cfg.kernelExponent;
      num += w * k;
      den += Math.abs(w) * k;
      mass += Math.abs(w) * k;
    }
  }
  if (cfg.normalization === "kernel") den += cfg.priorStrength;
  supportingLikes.sort((a, b) => b.similarity - a.similarity || a.dishId.localeCompare(b.dishId));
  // evidence ∈ [0,1): how much relevant session evidence exists for this dish (0 = none).
  const evidence = mass / (mass + Math.max(cfg.priorStrength, 1e-9));
  return { value: den === 0 ? 0 : clamp(num / den, -1, 1), evidence, supportingLikes };
}

const HOUR_MS = 3_600_000;

/** Unique confirmed meals inside the exposure window (duplicate ids counted once). */
export function recentConfirmedMeals(meals: readonly ConfirmedMeal[], now: string, windowDays: number): ConfirmedMeal[] {
  const nowMs = Date.parse(now);
  const seen = new Set<string>();
  const out: ConfirmedMeal[] = [];
  for (const m of meals) {
    if (!m.confirmed || seen.has(m.id)) continue;
    const age = nowMs - Date.parse(m.consumedAt);
    if (Number.isNaN(age) || age < 0 || age > windowDays * 24 * HOUR_MS) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * ETD §8.5 exposure. Only confirmed meals count; absent records mean "unknown", never "not eaten".
 * Unrecognized meals (no catalog dish) count toward coverage but contribute no similarity evidence.
 */
export function exposureAdjustment(dishId: string, inputs: ScoringInputs): { exposure: number; adjustment: number } {
  const cfg = inputs.policy.exposure;
  if (!cfg.enabled) return { exposure: 0, adjustment: 0 };
  const meals = recentConfirmedMeals(inputs.user.confirmedMeals, inputs.now, cfg.windowDays);
  if (meals.length === 0) return { exposure: 0, adjustment: 0 };
  const nowMs = Date.parse(inputs.now);
  let e = 0;
  for (const m of meals) {
    if (!m.dishId || !inputs.catalog.byId.has(m.dishId)) continue;
    const ageHours = (nowMs - Date.parse(m.consumedAt)) / HOUR_MS;
    const sim = dishSimilarity(inputs.catalog, dishId, m.dishId, inputs.policy.similarityKindWeights);
    e += sim * Math.exp((-Math.LN2 * ageHours) / cfg.halfLifeHours);
  }
  e = Math.min(cfg.exposureCap, e);
  const coverage = Math.min(1, meals.length / cfg.fullCoverageMeals);
  const adjustment = -Math.min(cfg.maxPenalty, cfg.penaltyPerUnit * e) * coverage;
  return { exposure: e, adjustment: adjustment === 0 ? 0 : adjustment };
}

/**
 * Personalized novelty N ∈ [-1,1] (ETD leaves N undefined; see deviation D-04).
 * N = (2·noveltyPreference − 1) × unfamiliarity, unfamiliarity = 1 − max similarity to any confirmed meal.
 * With no confirmed meals there is no familiarity evidence, so N = 0.
 */
export function noveltyScore(dishId: string, inputs: ScoringInputs): number {
  const meals = inputs.user.confirmedMeals.filter((m) => m.confirmed && m.dishId && inputs.catalog.byId.has(m.dishId));
  if (meals.length === 0) return 0;
  let maxSim = 0;
  for (const m of meals) {
    maxSim = Math.max(maxSim, dishSimilarity(inputs.catalog, dishId, m.dishId as string, inputs.policy.similarityKindWeights));
  }
  const pref = clamp(inputs.user.noveltyPreference, 0, 1);
  return clamp((2 * pref - 1) * (1 - maxSim), -1, 1);
}

export function scoreDish(dish: Dish, inputs: ScoringInputs): ScoreBreakdown {
  const w = inputs.policy.utilityWeights;
  const stable = weightAlignment(inputs.user.stableAttributeWeights, dish);
  const { value: current, evidence: currentEvidence, supportingLikes } = currentAppetite(dish.id, inputs);
  const softContext = weightAlignment(inputs.softAttributeWeights, dish);
  const novelty = noveltyScore(dish.id, inputs);
  const { exposure, adjustment } = exposureAdjustment(dish.id, inputs);
  const utility = clamp(w.stable * stable + w.current * current + w.softContext * softContext + w.novelty * novelty + adjustment, -1, 1);
  return { dishId: dish.id, stable, current, currentEvidence, softContext, novelty, exposure, exposureAdjustment: adjustment, utility, supportingLikes };
}

export const EMPTY_USER: UserModel = { stableAttributeWeights: {}, confirmedMeals: [], noveltyPreference: 0.5 };
