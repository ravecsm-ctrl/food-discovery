/**
 * Long-term taste profile — the "stable preference" signal P(u,d) (PRRD R-008, ETD §8.3).
 *
 * Learned ONLY from meals the person actually ate and rated (selection ≠ consumption ≠ satisfaction).
 * Swipes never count: a "No" is "not tonight", a "Yes" is not a favourite. Unrated meals are unknown,
 * not neutral evidence. Ratings fade with time, few ratings give weak weights (shrinkage), and dislikes
 * count half as much as likes so one bad meal doesn't ban a whole category.
 * taste-v1 adds strong preferences (strong-prefs.ts): a favourite counts as half a 5★ meal, a hidden dish
 * as half a 1★ meal (still damped). Without strong preferences, v1 gives exactly the v0 profile.
 * Provisional, versioned coefficients — change by adding a new id.
 */
import { cleanOwnDish, ownDishFeatures } from "./own-dish.ts";
import { activePrefs, STRONG_PREFS_V0, type StrongPreference } from "./strong-prefs.ts";
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

export const TASTE_V1 = { ...TASTE_V0, id: "taste-v1" } as const;

export interface RatedMeal {
  meal: ConfirmedMeal;
  /** 1–5 stars. */
  rating: number;
}

export interface TasteProfile {
  /** attribute → weight in [-maxWeight, maxWeight]; feeds UserModel.stableAttributeWeights. */
  weights: Record<string, number>;
  ratedMeals: number;
  /** Active favourites and hidden dishes that contributed (taste-v1). */
  favourites: number;
  hidden: number;
  version: typeof TASTE_V1.id;
}

const DAY_MS = 86_400_000;

function features(catalog: Catalog, m: Pick<ConfirmedMeal, "dishId" | "ownDish">): Record<string, number> | null {
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

/** Derive the taste profile from rated meals and strong preferences. Pure: same inputs + now ⇒ same profile. */
export function tasteProfile(catalog: Catalog, rated: readonly RatedMeal[], now: string, prefs: readonly StrongPreference[] = []): TasteProfile {
  const nowMs = Date.parse(now);
  const num = new Map<string, number>();
  const den = new Map<string, number>();
  const seen = new Set<string>();
  let used = 0;
  let favourites = 0;
  let hidden = 0;
  const add = (f: Record<string, number>, signal: number, weight: number) => {
    for (const [a, x] of Object.entries(f)) {
      num.set(a, (num.get(a) ?? 0) + signal * weight * x);
      den.set(a, (den.get(a) ?? 0) + weight * x);
    }
  };
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
    add(f, signal, decay);
  }
  for (const p of activePrefs(prefs, now)) {
    const f = features(catalog, { dishId: p.dishId, ownDish: null });
    const age = (nowMs - Date.parse(p.at)) / DAY_MS;
    if (!f || Number.isNaN(age) || age < -1) continue;
    const decay = Math.exp((-Math.LN2 * Math.max(0, age)) / TASTE_V0.halfLifeDays);
    if (p.kind === "favourite") {
      favourites++;
      add(f, 1, STRONG_PREFS_V0.favouriteWeight * decay);
    } else {
      hidden++;
      add(f, -TASTE_V0.negativeDamping, STRONG_PREFS_V0.hiddenWeight * decay);
    }
  }
  const weights: Record<string, number> = {};
  if (used + favourites + hidden >= TASTE_V0.minRatedMeals) {
    for (const [a, n] of [...num].sort(([x], [y]) => x.localeCompare(y))) {
      const w = n / ((den.get(a) ?? 0) + TASTE_V0.priorStrength);
      const clamped = Math.max(-TASTE_V0.maxWeight, Math.min(TASTE_V0.maxWeight, w));
      if (Math.abs(clamped) >= 0.02) weights[a] = Math.round(clamped * 1e6) / 1e6;
    }
  }
  return { weights, ratedMeals: used, favourites, hidden, version: TASTE_V1.id };
}

/** The strongest learned likes and dislikes, for display ("what we've learned"). */
export function tasteHighlights(profile: TasteProfile, n = 4): { likes: string[]; dislikes: string[] } {
  const entries = Object.entries(profile.weights);
  return {
    likes: entries.filter(([, w]) => w >= 0.1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([a]) => a),
    dislikes: entries.filter(([, w]) => w <= -0.08).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, n).map(([a]) => a),
  };
}
