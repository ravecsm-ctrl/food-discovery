/**
 * "In the mood for…" — an optional focus for tonight's session (cuisines and/or cravings).
 * It narrows which dishes are shown; it is not a dietary rule and never a safety claim.
 * Within a group, choices are alternatives (Japanese OR Korean); across groups, all apply
 * (Japanese AND noodles). Applies to this session only.
 */
import type { Dish } from "./types.ts";

export const CRAVINGS = {
  soup: { label: "Soup", test: (d: Dish) => at(d, ["structure:soup", "structure:noodle_soup"], 0.5) || at(d, ["texture:brothy"], 0.6) },
  noodles: {
    label: "Noodles",
    test: (d: Dish) =>
      at(d, ["structure:noodles", "structure:noodle_soup", "structure:pasta"], 0.5) ||
      at(d, ["ingredient:wheat_noodles", "ingredient:rice_noodles", "ingredient:pasta", "ingredient:glass_noodles", "ingredient:buckwheat_noodles"], 0.5),
  },
  rice: { label: "Rice", test: (d: Dish) => at(d, ["structure:rice_meal", "structure:rice_bowl", "structure:fried_rice", "structure:silog", "structure:risotto", "structure:porridge"], 0.5) },
  handheld: { label: "Burger / sandwich / wrap", test: (d: Dish) => at(d, ["structure:burger", "structure:sandwich", "structure:wraps", "structure:tacos", "structure:pizza"], 0.5) },
  grilled: { label: "Grilled", test: (d: Dish) => at(d, ["method:grilled"], 0.6) },
  fried: { label: "Fried", test: (d: Dish) => at(d, ["method:fried"], 0.6) },
  spicy: { label: "Spicy", test: (d: Dish) => at(d, ["flavor:spicy"], 0.5) },
  seafood: { label: "Seafood", test: (d: Dish) => at(d, ["ingredient:fish", "ingredient:shrimp", "ingredient:squid", "ingredient:clam", "ingredient:octopus"], 0.5) },
  light: { label: "Light & fresh", test: (d: Dish) => d.style === "light_fresh" },
  comfort: { label: "Comfort food", test: (d: Dish) => d.style === "comfort" || d.style === "hearty" },
} as const satisfies Record<string, { label: string; test: (d: Dish) => boolean }>;

export type CravingKey = keyof typeof CRAVINGS;

export interface SessionFocus {
  cuisines: string[];
  cravings: CravingKey[];
}

function at(d: Dish, attrs: string[], min: number): boolean {
  return attrs.some((a) => (d.attributes[a] ?? 0) >= min);
}

export function hasFocus(f: SessionFocus | undefined | null): f is SessionFocus {
  return !!f && (f.cuisines.length > 0 || f.cravings.length > 0);
}

export function inFocus(dish: Dish, f: SessionFocus | undefined | null): boolean {
  if (!hasFocus(f)) return true;
  const cuisineOk = f.cuisines.length === 0 || f.cuisines.includes(dish.cuisine);
  const cravingOk = f.cravings.length === 0 || f.cravings.some((c) => CRAVINGS[c]?.test(dish));
  return cuisineOk && cravingOk;
}
