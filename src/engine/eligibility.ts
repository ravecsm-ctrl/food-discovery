/**
 * Hard-constraint evaluation BEFORE ranking (ENG-009, R-009, R-023, ETD §8.7).
 *
 * - A confirmed-present conflict with a declared avoidance excludes the dish. No score can override this.
 * - "possible" or unknown ingredient information never becomes a safety claim.
 * - Fulfillment/budget are never claimed as verified without evidence (the prototype has none).
 */
import { inFocus } from "./mood.ts";
import type { Catalog, Dish, FulfillmentStatus, RestrictionKey, SafetyAssessment, SessionConstraints } from "./types.ts";

export interface EligibilityResult {
  dishId: string;
  eligible: boolean;
  /** Declared avoidances with a confirmed-present conflict. */
  excludedBy: RestrictionKey[];
  safety: SafetyAssessment;
  fulfillment: FulfillmentStatus;
  /** Prototype catalog has no reliable prices: a hard budget can never be confirmed as met. */
  budgetVerified: false;
  /** Outside tonight's "in the mood for…" focus (not a dietary exclusion). */
  outOfFocus: boolean;
}

export const DEFAULT_CONSTRAINTS: SessionConstraints = {
  acquisition: "any",
  acquisitionIsHard: false,
  maxBudgetPhp: null,
  avoidedIngredients: [],
  softAttributeWeights: {},
};

export function evaluateEligibility(dish: Dish, constraints: SessionConstraints): EligibilityResult {
  const avoided = new Set(constraints.avoidedIngredients);
  const excludedBy: RestrictionKey[] = [];
  const possibleConflicts: RestrictionKey[] = [];
  for (const claim of dish.ingredients) {
    if (!avoided.has(claim.key)) continue;
    if (claim.presence === "confirmed_present") excludedBy.push(claim.key);
    else if (claim.presence === "possible") possibleConflicts.push(claim.key);
  }

  const safety: SafetyAssessment =
    avoided.size === 0
      ? { status: "no_restrictions_declared", possibleConflicts: [] }
      : possibleConflicts.length > 0
        ? { status: "possible_conflict", possibleConflicts }
        : { status: "unverified", possibleConflicts: [] };

  // No verified availability data exists in M1. Dine-out/delivery can only be an external search.
  const fulfillment: FulfillmentStatus =
    constraints.acquisition === "delivery" || constraints.acquisition === "dine_out" ? "search_only" : "unverified";

  const outOfFocus = !inFocus(dish, constraints.focus);
  return {
    dishId: dish.id,
    eligible: excludedBy.length === 0 && !outOfFocus,
    excludedBy,
    safety,
    fulfillment,
    budgetVerified: false,
    outOfFocus,
  };
}

export interface CandidateSet {
  eligible: Dish[];
  /** Excluded by declared dietary avoidances only (the count shown as "hidden because of restrictions"). */
  excluded: EligibilityResult[];
  /** Dishes outside tonight's mood focus (not counted as dietary exclusions). */
  outOfFocus: number;
  byId: Map<string, EligibilityResult>;
}

/** Build the eligible candidate set in catalog order. Pure; never mutates the catalog. */
export function buildCandidates(catalog: Catalog, constraints: SessionConstraints): CandidateSet {
  const eligible: Dish[] = [];
  const excluded: EligibilityResult[] = [];
  const byId = new Map<string, EligibilityResult>();
  let outOfFocus = 0;
  for (const dish of catalog.dishes) {
    const r = evaluateEligibility(dish, constraints);
    byId.set(dish.id, r);
    if (r.eligible) eligible.push(dish);
    else if (r.excludedBy.length > 0) excluded.push(r);
    else outOfFocus++;
  }
  return { eligible, excluded, outOfFocus, byId };
}
