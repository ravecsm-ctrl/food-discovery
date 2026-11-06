/**
 * Domain contracts for the food-recommendation engine (ETD §3.2).
 * Pure data types — no framework, browser, or cloud dependencies (ETD ED-003).
 */

export type ISODateTime = string;

export const ATTRIBUTE_KINDS = [
  "ingredient",
  "method",
  "flavor",
  "texture",
  "structure",
  "richness",
  "temperature",
  "cuisine",
] as const;
export type FoodAttributeKind = (typeof ATTRIBUTE_KINDS)[number];

/** Attribute id format: `${kind}:${slug}` e.g. "flavor:sour". */
export type AttributeId = `${FoodAttributeKind}:${string}`;

/** Editorial "how it's typically eaten" labels shown on cards and used by taste fatigue (D-08). */
export const DISH_STYLES = ["comfort", "light_fresh", "hearty", "street_food", "rich_indulgent", "sharing"] as const;
export type DishStyle = (typeof DISH_STYLES)[number];

export type EvidenceStatus = "curated" | "verified_source" | "inferred" | "unknown";

/** Keys a person can declare as hard avoidances. Generic dish claims only — never recipe guarantees. */
export const RESTRICTION_KEYS = [
  "shellfish",
  "fish",
  "pork",
  "beef",
  "chicken",
  "egg",
  "dairy",
  "gluten",
  "peanut",
  "tree_nut",
  "soy",
  "sesame",
] as const;
export type RestrictionKey = (typeof RESTRICTION_KEYS)[number];

/** ETD §4.3 ingredient_claims.presence. There is deliberately no "absent" state. */
export type IngredientPresence = "confirmed_present" | "possible" | "unknown";

export interface IngredientClaim {
  key: RestrictionKey;
  presence: IngredientPresence;
}

export interface Dish {
  id: string;
  familyId: string | null;
  name: string;
  cuisine: string;
  style: DishStyle;
  description: string;
  tags: string[];
  /** 0 = light, 1 = very rich. Editorial estimate. */
  richness: number;
  /** 0–1 editorial estimate of local (PH) recognizability; used only for cold-start card choice. */
  recognizability: number;
  illustration: string;
  attributes: Record<string, number>;
  ingredients: IngredientClaim[];
}

export interface Catalog {
  catalogVersion: string;
  status: "draft" | "published" | "retired";
  attributeEvidence: EvidenceStatus;
  dishes: readonly Dish[];
  byId: ReadonlyMap<string, Dish>;
}

export type ReactionValue = "yes" | "no";
export type ReactionStrength = "ordinary" | "explicit";

export interface CardExposure {
  exposureId: string;
  dishId: string;
  position: number;
  shownAt: ISODateTime;
  /** true when the card was displayed but then withdrawn by an Undo of the previous card. */
  withdrawn: boolean;
  /** Deterministic policies select with probability 1 (ETD §8.12). */
  selectionProbability: number;
}

export interface Reaction {
  reactionId: string;
  /** One logical action; undo invalidates the whole group (ETD §4.4). */
  actionGroupId: string;
  exposureId: string;
  dishId: string;
  value: ReactionValue;
  strength: ReactionStrength;
  active: boolean;
  recordedAt: ISODateTime;
  invalidatedAt: ISODateTime | null;
}

export interface ConfirmedMeal {
  id: string;
  dishId: string | null;
  /** Free-text name when the dish is not in the catalog. Never published to the catalog. */
  unrecognizedName?: string | null;
  consumedAt: ISODateTime;
  confirmed: true;
  /** "synthetic" meals are test fixtures entered in the prototype lab; "recall" = typed into the recent-meals opener. */
  source: "selection_confirmation" | "manual" | "recall" | "synthetic";
  /** True when the time is an approximation ("last night"). */
  timeApprox?: boolean;
}

export interface UserModel {
  /** Explicit/derived long-term preferences, -1..+1. Empty = neutral (not dislike). */
  stableAttributeWeights: Record<string, number>;
  confirmedMeals: ConfirmedMeal[];
  /** 0..1; 0.5 = neutral. */
  noveltyPreference: number;
  /**
   * How strongly recent meals should push towards variety (taste fatigue v2).
   * 0.5 = "I like routine", 1 = normal, 1.5 = "I get bored quickly". Defaults to 1.
   */
  varietySeeking?: number;
}

export interface SessionConstraints {
  acquisition: "any" | "cook" | "dine_out" | "delivery";
  /** If acquisition is a hard requirement (not merely a preference). */
  acquisitionIsHard: boolean;
  maxBudgetPhp: number | null;
  avoidedIngredients: RestrictionKey[];
  softAttributeWeights: Record<string, number>;
}

export interface PolicyContext {
  policyId: string;
  catalogVersion: string;
  now: ISODateTime;
  seed: number;
}

export type ReasonCode =
  | "CURRENT_SESSION_POSITIVE"
  | "STABLE_PREFERENCE_MATCH"
  | "SHARED_SESSION_POSITIVE"
  | "BOTH_PARTICIPANTS_LIKED"
  | "RECENT_FOOD_VARIETY"
  | "NOVELTY_EXPLORATION"
  | "HARD_CONSTRAINT_EXCLUDED"
  | "FULFILLMENT_UNVERIFIED"
  | "INSUFFICIENT_EVIDENCE";

export type FulfillmentStatus = "verified" | "unverified" | "search_only";

/** Safety labelling relative to the person's declared avoidances (never a safety guarantee). */
export type SafetyStatus =
  /** No avoidances declared — we still make no allergen claim. */
  | "no_restrictions_declared"
  /** Avoidances declared; no listed conflict, but absence is NOT verified. */
  | "unverified"
  /** Avoidances declared and a "possible" conflict exists. */
  | "possible_conflict";

export interface SafetyAssessment {
  status: SafetyStatus;
  possibleConflicts: RestrictionKey[];
}
