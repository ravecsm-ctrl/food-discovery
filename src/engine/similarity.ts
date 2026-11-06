/**
 * Food feature vectors and multi-attribute similarity (ENG-008, R-026, ETD §8.2).
 */
import type { Catalog, Dish } from "./types.ts";

export type FeatureVector = ReadonlyMap<string, number>;

const vectorCache = new WeakMap<Dish, FeatureVector>();

/**
 * Sparse vector x(d, attribute) ∈ [0,1].
 * Cuisine becomes a one-hot feature; scalar richness is split into rich/light so cosine
 * similarity reflects closeness rather than mere presence.
 */
export function featureVector(dish: Dish): FeatureVector {
  const cached = vectorCache.get(dish);
  if (cached) return cached;
  const v = new Map<string, number>(Object.entries(dish.attributes));
  v.set(`cuisine:${dish.cuisine}`, 1);
  v.set("richness:rich", dish.richness);
  v.set("richness:light", 1 - dish.richness);
  vectorCache.set(dish, v);
  return v;
}

function kindOf(attributeId: string): string {
  const i = attributeId.indexOf(":");
  return i === -1 ? attributeId : attributeId.slice(0, i);
}

/**
 * Weighted mean of per-kind cosine similarities, in [0,1].
 * Kinds absent from either dish are treated as unknown and excluded (missing ≠ zero, ETD §3.3).
 */
export function vectorSimilarity(a: FeatureVector, b: FeatureVector, kindWeights: Record<string, number>): number {
  const dot: Record<string, number> = {};
  const na: Record<string, number> = {};
  const nb: Record<string, number> = {};
  for (const [k, x] of a) {
    const kind = kindOf(k);
    na[kind] = (na[kind] ?? 0) + x * x;
    const y = b.get(k);
    if (y !== undefined) dot[kind] = (dot[kind] ?? 0) + x * y;
  }
  for (const [k, y] of b) {
    const kind = kindOf(k);
    nb[kind] = (nb[kind] ?? 0) + y * y;
  }
  let total = 0;
  let weightSum = 0;
  for (const [kind, w] of Object.entries(kindWeights)) {
    const A = na[kind] ?? 0;
    const B = nb[kind] ?? 0;
    if (A === 0 || B === 0 || w <= 0) continue;
    total += w * ((dot[kind] ?? 0) / Math.sqrt(A * B));
    weightSum += w;
  }
  if (weightSum === 0) return 0;
  return clamp(total / weightSum, 0, 1);
}

const pairCache = new WeakMap<Catalog, WeakMap<object, Map<string, number>>>();

/** Similarity between two catalog dishes, memoized per catalog and kind-weight configuration. */
export function dishSimilarity(
  catalog: Catalog,
  aId: string,
  bId: string,
  kindWeights: Record<string, number>,
): number {
  if (aId === bId) return 1;
  let byWeights = pairCache.get(catalog);
  if (!byWeights) {
    byWeights = new WeakMap();
    pairCache.set(catalog, byWeights);
  }
  let cache = byWeights.get(kindWeights);
  if (!cache) {
    cache = new Map();
    byWeights.set(kindWeights, cache);
  }
  const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const a = catalog.byId.get(aId);
  const b = catalog.byId.get(bId);
  if (!a || !b) throw new Error(`Unknown dish id in similarity: ${!a ? aId : bId}`);
  const s = vectorSimilarity(featureVector(a), featureVector(b), kindWeights);
  cache.set(key, s);
  return s;
}

/** Attributes two dishes share most strongly — used to ground explanations. */
export function sharedAttributes(a: Dish, b: Dish, limit = 2): string[] {
  const out: Array<[string, number]> = [];
  for (const [k, x] of Object.entries(a.attributes)) {
    const y = b.attributes[k];
    if (y !== undefined && !k.startsWith("structure:")) out.push([k, Math.min(x, y)]);
  }
  out.sort((p, q) => q[1] - p[1] || p[0].localeCompare(q[0]));
  return out.filter(([, s]) => s >= 0.5).slice(0, limit).map(([k]) => k);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
