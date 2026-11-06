/**
 * Dish search used wherever people name a food (recent meals, "what did you eat?", corrections).
 * Matches the dish name, its alternate names (aliases), and cuisine, by whole word or word start,
 * and tolerates one typo in longer words ("shwarma" → Shawarma). Pure and deterministic.
 */
import { cuisineName, type Catalog, type ConfirmedMeal, type Dish } from "@/engine";

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const words = (s: string) => normalize(s).split(" ").filter(Boolean);

/** At most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

const allPrefix = (q: string[], ws: string[]) => q.length > 0 && q.every((t) => ws.some((w) => w.startsWith(t)));

/** Relevance of a dish for a query (0 = no match). Higher is better. */
export function matchScore(dish: Dish, query: string): number {
  const q = normalize(query);
  if (!q) return 0;
  const qt = q.split(" ");
  const name = normalize(dish.name);
  const aliases = (dish.aliases ?? []).map(normalize);
  const nameWords = name.split(" ");
  const aliasWords = aliases.flatMap((a) => a.split(" "));
  const all = [...nameWords, ...aliasWords, ...words(cuisineName(dish.cuisine))];

  if (name === q) return 100;
  if (aliases.includes(q)) return 90;
  if (name.startsWith(q)) return 80;
  if (allPrefix(qt, nameWords)) return 70;
  if (aliases.some((a) => a.startsWith(q)) || allPrefix(qt, aliasWords)) return 60;
  if (name.includes(q)) return 50;
  if (aliases.some((a) => a.includes(q))) return 40;
  if (allPrefix(qt, all)) return 30;
  if (qt.every((t) => t.length >= 4 && all.some((w) => withinOneEdit(t, w) || (w.length > t.length && withinOneEdit(t, w.slice(0, t.length)))))) return 20;
  return 0;
}

export function searchDishes(catalog: Catalog, query: string, limit = 6): Dish[] {
  return catalog.dishes
    .map((d) => ({ d, s: matchScore(d, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.d.recognizability - a.d.recognizability || a.d.name.localeCompare(b.d.name))
    .slice(0, limit)
    .map((x) => x.d);
}

/**
 * The dish a free-text meal name most likely means — its exact name or alternate name — to SUGGEST
 * re-linking (the person confirms; nothing changes automatically). Ties go to the more familiar dish.
 */
export function confidentMatch(catalog: Catalog, name: string): Dish | null {
  const ranked = catalog.dishes.map((d) => ({ d, s: matchScore(d, name) })).filter((x) => x.s >= 90);
  ranked.sort((a, b) => b.s - a.s || b.d.recognizability - a.d.recognizability || a.d.name.localeCompare(b.d.name));
  return ranked[0]?.d ?? null;
}

export interface UnlistedFood {
  /** As first typed. */
  name: string;
  mealIds: string[];
  lastAt: string;
  /** A dish now in the list that this name clearly refers to, if any. */
  match: Dish | null;
}

/** Foods logged by name because they weren't in the dish list — the evidence for what to add next. */
export function unlistedFoods(catalog: Catalog, meals: readonly ConfirmedMeal[]): UnlistedFood[] {
  const groups = new Map<string, UnlistedFood>();
  for (const m of meals) {
    if (m.dishId || !m.unrecognizedName?.trim()) continue;
    const key = normalize(m.unrecognizedName);
    const g = groups.get(key);
    if (g) {
      g.mealIds.push(m.id);
      if (m.consumedAt > g.lastAt) g.lastAt = m.consumedAt;
    } else {
      groups.set(key, { name: m.unrecognizedName.trim(), mealIds: [m.id], lastAt: m.consumedAt, match: confidentMatch(catalog, m.unrecognizedName) });
    }
  }
  return [...groups.values()].sort((a, b) => b.mealIds.length - a.mealIds.length || b.lastAt.localeCompare(a.lastAt));
}
