/**
 * Long-term taste profile — the "stable preference" signal P(u,d) (PRRD R-008, ETD §8.3).
 *
 * Learned ONLY from meals the person actually ate and rated (selection ≠ consumption ≠ satisfaction).
 * Swipes never count: a "No" is "not tonight", a "Yes" is not a favourite. Unrated meals are unknown,
 * not neutral evidence. Ratings fade with time, few ratings give weak weights (shrinkage), and dislikes
 * count half as much as likes so one bad meal doesn't ban a whole category.
 * Provisional, versioned coefficients — change by adding a new id.
 */
import { cleanOwnDish, ownDishFeatures } from "./own-dish.ts";
import type { Catalog, ConfirmedMeal } from "./types.ts";

export const TASTE_V0 = {
  id: "taste-v0",
  halfLifeDays: 60,
  /** Pseudo-observations of "no opinion" per attribute: shrinks weights when evidence is thin. */
  priorStrength: 2,
  /** Dislikes (1–2★) move weights half as much as likes. */
  negativeDamping: 0.5,
  maxWeight: 0.8,
  /** Below this many rated meals, no profile is used at all. */
  minRatedMeals: 2,
  /** Staples and ubiquitous qualities say little about taste. */
  exempt: ["ingredient:rice", "ingredient:vegetables", "structure:rice_meal", "flavor:savory"],
  /** Which attribute kinds can carry long-term taste. */
  kinds: ["ingredient", "method", "flavor", "texture", "structure", "cuisine"],
} as const;

export interface RatedMeal {
  meal: ConfirmedMeal;
  /** 1–5 stars. */
  rating: number;
}

export interface TasteProfile {
  /** attribute → weight in [-maxWeight, maxWeight]; feeds UserModel.stableAttributeWeights. */
  weights: Record<string, number>;
  ratedMeals: number;
  version: typeof TASTE_V0.id;
}

const DAY_MS = 86_400_000;

function features(catalog: Catalog, m: ConfirmedMeal): Record<string, number> | null {
  const dish = m.dishId ? catalog.byId.get(m.dishId) : null;
  const own = m.dishId ? null : cleanOwnDish(m.ownDish);
  const base = dish ? { attributes: dish.attributes, cuisine: dish.cuisine } : own ? ownDishFeatures(own) : null;
  if (!base) return null;
  const out: Record<string, number> = {};
  for (const [a, x] of Object.entries(base.attributes)) {
    if (x > 0 && !(TASTE_V0.exempt as readonly string[]).includes(a) && (TASTE_V0.kinds as readonly string[]).includes(a.split(":")[0] ?? "")) out[a] = x;
  }
  if (base.cuisine) out[`cuisine:${base.cuisine}`] = 1;
  return out;
}

/** Derive the taste profile from rated meals. Pure: same meals + ratings + now ⇒ same profile. */
export function tasteProfile(catalog: Catalog, rated: readonly RatedMeal[], now: string): TasteProfile {
  const nowMs = Date.parse(now);
  const num = new Map<string, number>();
  const den = new Map<string, number>();
  const seen = new Set<string>();
  let used = 0;
  for (const { meal, rating } of rated) {
    if (!meal.confirmed || seen.has(meal.id) || !Number.isInteger(rating) || rating < 1 || rating > 5) continue;
    const age = (nowMs - Date.parse(meal.consumedAt)) / DAY_MS;
    if (Number.isNaN(age) || age < -1) continue;
    const f = features(catalog, meal);
    if (!f) continue; // undescribed free-text meal: no evidence about taste
    seen.add(meal.id);
    used++;
    const raw = (rating - 3) / 2; // 1★ −1 · 3★ 0 · 5★ +1
    const signal = raw < 0 ? raw * TASTE_V0.negativeDamping : raw;
    const decay = Math.exp((-Math.LN2 * Math.max(0, age)) / TASTE_V0.halfLifeDays);
    for (const [a, x] of Object.entries(f)) {
      num.set(a, (num.get(a) ?? 0) + signal * decay * x);
      den.set(a, (den.get(a) ?? 0) + decay * x);
    }
  }
  const weights: Record<string, number> = {};
  if (used >= TASTE_V0.minRatedMeals) {
    for (const [a, n] of [...num].sort(([x], [y]) => x.localeCompare(y))) {
      const w = n / ((den.get(a) ?? 0) + TASTE_V0.priorStrength);
      const clamped = Math.max(-TASTE_V0.maxWeight, Math.min(TASTE_V0.maxWeight, w));
      if (Math.abs(clamped) >= 0.02) weights[a] = Math.round(clamped * 1e6) / 1e6;
    }
  }
  return { weights, ratedMeals: used, version: TASTE_V0.id };
}

/** The strongest learned likes and dislikes, for display ("what we've learned"). */
export function tasteHighlights(profile: TasteProfile, n = 4): { likes: string[]; dislikes: string[] } {
  const entries = Object.entries(profile.weights);
  return {
    likes: entries.filter(([, w]) => w >= 0.1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([a]) => a),
    dislikes: entries.filter(([, w]) => w <= -0.08).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, n).map(([a]) => a),
  };
}
