/**
 * "Add your own dish" (library step 2; PRRD §9.4, R-015). When a food isn't in the dish list, the
 * person describes it with a few fixed choices. The engine turns that description into the same
 * attribute vocabulary as the catalog so it counts toward taste fatigue. It is private meal data: it
 * never enters the shared catalog and never makes any ingredient or allergen claim.
 */
import type { Dish } from "./types.ts";

export interface OwnDish {
  cuisine: string | null;
  /** Up to two main ingredients, most important first. */
  mains: string[];
  method: string | null;
  /** What kind of dish it is (structure), e.g. "wraps", "noodle_soup". */
  type: string | null;
  /** Up to three flavours/textures. */
  flavors: string[];
}

/** Fixed choices (slugs from the catalog vocabulary) with display labels. */
export const OWN_DISH_OPTIONS = {
  cuisine: [
    ["filipino", "Filipino"], ["japanese", "Japanese"], ["korean", "Korean"], ["chinese", "Chinese"], ["thai", "Thai"],
    ["vietnamese", "Vietnamese"], ["indian", "Indian"], ["middle_eastern", "Middle Eastern"], ["italian", "Italian"],
    ["mexican", "Mexican"], ["western", "Western"], ["international", "Other"],
  ],
  mains: [
    ["chicken", "Chicken"], ["pork", "Pork"], ["beef", "Beef"], ["lamb", "Lamb"], ["fish", "Fish"], ["shrimp", "Seafood"],
    ["tofu", "Tofu"], ["egg", "Egg"], ["vegetables", "Vegetables"], ["cheese", "Cheese"], ["rice", "Rice"],
    ["wheat_noodles", "Noodles"], ["bread_dough", "Bread / dough"],
  ],
  method: [
    ["fried", "Fried"], ["grilled", "Grilled"], ["stir_fried", "Stir-fried"], ["simmered", "Simmered / soup"],
    ["braised", "Braised / stewed"], ["baked", "Baked / roasted"], ["steamed", "Steamed"], ["raw", "Raw / fresh"],
  ],
  type: [
    ["rice_meal", "Rice meal"], ["noodles", "Noodles"], ["noodle_soup", "Noodle soup"], ["soup", "Soup"], ["stew", "Stew / curry"],
    ["wraps", "Wrap"], ["sandwich", "Sandwich"], ["burger", "Burger"], ["skewers", "Skewers"], ["salad", "Salad"],
    ["street_snack", "Snack"], ["grilled_plate", "Plate"],
  ],
  flavors: [
    ["flavor:savory", "Savory"], ["flavor:spicy", "Spicy"], ["flavor:sweet", "Sweet"], ["flavor:sour", "Sour"], ["flavor:garlicky", "Garlicky"],
    ["flavor:smoky", "Smoky"], ["flavor:spiced", "Warmly spiced"], ["flavor:herbal", "Herby"], ["texture:creamy", "Creamy"],
    ["texture:crispy", "Crispy"], ["texture:brothy", "Brothy"], ["texture:saucy", "Saucy"],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, string]>>;

const allowed = (group: keyof typeof OWN_DISH_OPTIONS) => new Set<string>(OWN_DISH_OPTIONS[group].map(([slug]) => slug));
export const OWN_DISH_LIMITS = { mains: 2, flavors: 3 } as const;

/** Normalise and validate a description; returns null when it describes nothing usable. */
export function cleanOwnDish(d: Partial<OwnDish> | null | undefined): OwnDish | null {
  if (!d) return null;
  const pick = (v: unknown, g: keyof typeof OWN_DISH_OPTIONS) => (typeof v === "string" && allowed(g).has(v) ? v : null);
  const many = (v: unknown, g: keyof typeof OWN_DISH_OPTIONS, max: number) =>
    Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && allowed(g).has(x)))].slice(0, max) : [];
  const out: OwnDish = {
    cuisine: pick(d.cuisine, "cuisine"),
    mains: many(d.mains, "mains", OWN_DISH_LIMITS.mains),
    method: pick(d.method, "method"),
    type: pick(d.type, "type"),
    flavors: many(d.flavors, "flavors", OWN_DISH_LIMITS.flavors),
  };
  const anything = out.cuisine || out.mains.length || out.method || out.type || out.flavors.length;
  return anything ? out : null;
}

/** The catalog-style dish features a description implies (used for taste fatigue only). */
export function ownDishFeatures(d: OwnDish): Pick<Dish, "attributes"> & { cuisine: string | null } {
  const a: Record<string, number> = {};
  d.mains.forEach((m, i) => (a[`ingredient:${m}`] = i === 0 ? 1 : 0.7));
  if (d.method) a[`method:${d.method}`] = 1;
  if (d.type) a[`structure:${d.type}`] = 1;
  for (const f of d.flavors) a[f] = 0.8;
  // Implied textures, only when the person didn't already choose one.
  if (d.method === "fried" && !a["texture:crispy"]) a["texture:crispy"] = 0.6;
  if ((d.type === "soup" || d.type === "noodle_soup") && !a["texture:brothy"]) a["texture:brothy"] = 0.8;
  return { attributes: a, cuisine: d.cuisine && d.cuisine !== "international" ? d.cuisine : null };
}

/** Short human summary, e.g. "Middle Eastern · grilled · beef · wrap". */
export function ownDishSummary(d: OwnDish): string {
  const label = (g: keyof typeof OWN_DISH_OPTIONS, slug: string | null) => (slug ? (OWN_DISH_OPTIONS[g].find(([s]) => s === slug)?.[1] ?? null) : null);
  return [
    label("cuisine", d.cuisine),
    label("method", d.method)?.toLowerCase(),
    ...d.mains.map((m) => label("mains", m)?.toLowerCase()),
    label("type", d.type)?.toLowerCase(),
    ...d.flavors.map((f) => label("flavors", f)?.toLowerCase()),
  ]
    .filter(Boolean)
    .join(" · ");
}
