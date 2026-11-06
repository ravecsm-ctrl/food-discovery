/**
 * Taste fatigue v2 — attribute-level recent-exposure model (R-012, PRRD §10.4, deviation D-09).
 *
 * Grounding (provisional, not a validated model):
 * - Sensory-specific satiety: the pleasantness of a food's specific sensory qualities (flavor, texture)
 *   drops after eating it, while different foods stay appealing; the effect recovers over hours.
 * - Repeated consumption over days can lower liking, but the effect varies by person and food;
 *   staples and ubiquitous qualities (rice, "savory") fatigue little.
 *
 * So fatigue is computed per sensory attribute, decays with a ~1 day half-life, ignores staples,
 * scales with the person's variety-seeking, and is damped when the person shows appetite for the
 * dish right now (tonight's "yes" beats history). Only CONFIRMED meals count; missing meals = unknown.
 */
import { clamp } from "./similarity.ts";
import type { Catalog, ConfirmedMeal, Dish } from "./types.ts";
import { cleanOwnDish, ownDishFeatures } from "./own-dish.ts";

/** What fatigue needs from a dish: catalog dishes, or a person's own described dish (no style). */
type FatigueDish = Pick<Dish, "attributes"> & { cuisine: string | null; style?: Dish["style"] };

export interface FatigueConfig {
  enabled: boolean;
  halfLifeHours: number;
  windowDays: number;
  /** Meals in the window needed for full confidence (coverage = n / this, max 1). */
  fullCoverageMeals: number;
  /** Max utility reduction at fatigue 1, coverage 1, varietySeeking 1. */
  maxPenalty: number;
  /** Multiply the penalty by (1 − positive current appetite). */
  appetiteDamping: boolean;
  /** Which attribute kinds can fatigue, and how much each counts. */
  kindWeights: Record<string, number>;
  /** Staples / ubiquitous qualities that never drive fatigue. */
  exempt: string[];
  /** A dish counts as a "fresh change" when its fatigue is at or below this. */
  freshMax: number;
}

export const FATIGUE_V2: FatigueConfig = {
  enabled: true,
  halfLifeHours: 24,
  windowDays: 4,
  fullCoverageMeals: 3,
  maxPenalty: 0.15,
  appetiteDamping: true,
  kindWeights: { flavor: 0.2, texture: 0.2, method: 0.2, ingredient: 0.15, style: 0.15, cuisine: 0.1, structure: 0.1 },
  exempt: ["ingredient:rice", "ingredient:vegetables", "structure:rice_meal", "flavor:savory"],
  freshMax: 0.25,
};

export interface RecentLoad {
  /** attribute → recent load in [0,1] */
  load: Map<string, number>;
  mealsInWindow: number;
  coverage: number;
}

const HOUR_MS = 3_600_000;

function kindOf(attr: string): string {
  const i = attr.indexOf(":");
  return i === -1 ? attr : attr.slice(0, i);
}

/** Fatigable attributes of a dish with their strengths. */
export function fatigueFeatures(dish: FatigueDish, cfg: FatigueConfig): Array<[string, number]> {
  const all: Array<[string, number]> = [
    ...Object.entries(dish.attributes),
    ...(dish.cuisine ? ([[`cuisine:${dish.cuisine}`, 1]] as Array<[string, number]>) : []),
    ...(dish.style ? ([[`style:${dish.style}`, 1]] as Array<[string, number]>) : []),
  ];
  return all.filter(([a, x]) => x > 0 && (cfg.kindWeights[kindOf(a)] ?? 0) > 0 && !cfg.exempt.includes(a));
}

const loadCache = new WeakMap<readonly ConfirmedMeal[], Map<string, RecentLoad>>();

/** Sum of time-decayed attribute exposure from confirmed meals in the window (duplicates by id counted once). */
export function recentLoad(catalog: Catalog, meals: readonly ConfirmedMeal[], now: string, cfg: FatigueConfig): RecentLoad {
  const key = `${catalog.catalogVersion}|${now}|${cfg.halfLifeHours}|${cfg.windowDays}|${cfg.fullCoverageMeals}`;
  let byKey = loadCache.get(meals);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const nowMs = Date.parse(now);
  const seen = new Set<string>();
  const load = new Map<string, number>();
  let n = 0;
  for (const m of meals) {
    if (!m.confirmed || seen.has(m.id)) continue;
    const age = (nowMs - Date.parse(m.consumedAt)) / HOUR_MS;
    if (Number.isNaN(age) || age < 0 || age > cfg.windowDays * 24) continue;
    seen.add(m.id);
    n++;
    const own = m.dishId ? null : cleanOwnDish(m.ownDish);
    const dish: FatigueDish | undefined = m.dishId ? catalog.byId.get(m.dishId) : own ? ownDishFeatures(own) : undefined;
    if (!dish) continue; // unrecognized, undescribed meal: counts toward coverage, no attribute evidence
    const w = Math.exp((-Math.LN2 * age) / cfg.halfLifeHours);
    for (const [a, x] of fatigueFeatures(dish, cfg)) load.set(a, (load.get(a) ?? 0) + w * x);
  }
  for (const [a, v] of load) load.set(a, Math.min(1, v));
  const result: RecentLoad = { load, mealsInWindow: n, coverage: Math.min(1, n / cfg.fullCoverageMeals) };
  if (!byKey) {
    byKey = new Map();
    loadCache.set(meals, byKey);
  }
  byKey.set(key, result);
  return result;
}

/** Fraction (0..1) of a dish's weighted character that was eaten recently. */
export function dishFatigue(dish: Dish, recent: RecentLoad, cfg: FatigueConfig): number {
  let num = 0;
  let den = 0;
  for (const [a, x] of fatigueFeatures(dish, cfg)) {
    const w = (cfg.kindWeights[kindOf(a)] ?? 0) * x;
    den += w;
    num += w * (recent.load.get(a) ?? 0);
  }
  return den === 0 ? 0 : clamp(num / den, 0, 1);
}

/** Utility adjustment (≤ 0). */
export function fatigueAdjustment(fatigue: number, recent: RecentLoad, cfg: FatigueConfig, currentAppetite: number, varietySeeking = 1): number {
  if (!cfg.enabled || recent.mealsInWindow === 0) return 0;
  const damping = cfg.appetiteDamping ? 1 - Math.max(0, currentAppetite) : 1;
  const v = clamp(varietySeeking, 0, 2);
  const adj = -cfg.maxPenalty * fatigue * recent.coverage * v * damping;
  return adj === 0 ? 0 : adj;
}

/**
 * The recently-eaten qualities this dish offers a break from (for grounded explanations):
 * attributes with substantial recent load that the dish does not have.
 */
export function varietyEvidence(dish: Dish, recent: RecentLoad, cfg: FatigueConfig, limit = 2): string[] {
  const own = new Set(fatigueFeatures(dish, cfg).map(([a]) => a));
  const preferredKinds = ["style", "method", "texture", "flavor", "cuisine"];
  return [...recent.load]
    .filter(([a, l]) => l >= 0.5 && !own.has(a) && preferredKinds.includes(kindOf(a)))
    .sort((p, q) => q[1] - p[1] || preferredKinds.indexOf(kindOf(p[0])) - preferredKinds.indexOf(kindOf(q[0])) || p[0].localeCompare(q[0]))
    .slice(0, limit)
    .map(([a]) => a);
}
