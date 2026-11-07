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
  /** Other names people search by (search only). */
  aliases?: string[];
  /** Meal-time fit overrides where local habits differ from the general rules (-1..1). */
  mealTimes?: Partial<Record<import("./meal-time.ts").MealTime, number>>;
  /** 0 = light, 1 = very rich. Editorial estimate. */
  richness: number;
  /** 0–1 editorial estimate of local (PH) recognizability; used only for cold-start card choice. */
  recognizability: number;
  illustration: string;
  /** Optional rights-cleared photo with recorded provenance (PRRD §9.5). Without one, the illustration is shown. */
  photo?: DishPhoto;
  attributes: Record<string, number>;
  ingredients: IngredientClaim[];
}

/** Licences we accept for dish photos: free to reuse, credit shown where required. */
export const PHOTO_LICENSES = ["CC0", "Public domain", "CC BY 2.0", "CC BY 2.5", "CC BY 3.0", "CC BY 4.0", "CC BY-SA 2.0", "CC BY-SA 2.5", "CC BY-SA 3.0", "CC BY-SA 4.0"] as const;
export type PhotoLicense = (typeof PHOTO_LICENSES)[number];

export interface DishPhoto {
  /** Path under public/, e.g. "photos/dish-bulalo.jpg" (a resized copy kept with the app, never hot-linked). */
  file: string;
  /** The original file's page (e.g. on Wikimedia Commons). */
  source: string;
  author: string;
  license: PhotoLicense;
  licenseUrl?: string;
  /** What we changed, as BY-SA asks (e.g. "Resized and cropped"). */
  changes: string;
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
  /**
   * Together Mode only: who this reaction belongs to when the pair disagreed ("a" = phone owner,
   * "b" = partner). Absent = one shared reaction for the card (or a solo reaction). A shared Yes is
   * never treated as two separately observed individual Yes reactions (ETD §8.10, R-011).
   */
  participant?: "a" | "b";
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
  /** For a food not in the dish list: the person's own short description (see own-dish.ts). */
  ownDish?: import("./own-dish.ts").OwnDish | null;
  /** How much the person enjoyed it, 1–5 stars, if they said (satisfaction ≠ consumption). */
  rating?: number | null;
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
  /** Dishes the person saved with "Love it" (strong-prefs.ts). Used for reasons; taste comes via weights. */
  favouriteDishIds?: string[];
}

export interface SessionConstraints {
  acquisition: "any" | "cook" | "dine_out" | "delivery";
  /** If acquisition is a hard requirement (not merely a preference). */
  acquisitionIsHard: boolean;
  maxBudgetPhp: number | null;
  avoidedIngredients: RestrictionKey[];
  softAttributeWeights: Record<string, number>;
  /** Optional "in the mood for…" focus for this session (not a dietary rule). */
  focus?: import("./mood.ts").SessionFocus;
  /** Which meal this session is for (from the clock, or chosen by the person). */
  mealTime?: import("./meal-time.ts").MealTime;
  /** Dishes the person hid ("Not for a while" / "Never show again"). A taste choice, not a dietary rule. */
  hiddenDishIds?: string[];
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
  /** Extension (owner request 2026-11-07): a good fit for the meal this session is for. */
  | "MEAL_TIME_FIT"
  /** Extension (owner request 2026-11-07): the person saved this dish with "Love it". */
  | "SAVED_FAVOURITE"
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
