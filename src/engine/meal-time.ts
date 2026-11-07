/**
 * Meal-time fit — how suitable a dish is for breakfast, lunch, merienda, dinner or late night
 * (owner request 2026-11-07). A soft, explainable context signal: it nudges ranking and card order,
 * never excludes a dish, and the person can always override the meal time.
 *
 * Fit ∈ [-1, 1] comes from general rules on the dish's structure and style (e.g. silog → breakfast,
 * sharing plates and stews → dinner, street snacks → merienda), plus per-dish catalog overrides
 * (`mealTimes`) where local habits differ from the rule (e.g. pancit for merienda). Editorial, provisional.
 */
import type { Dish } from "./types.ts";

export const MEAL_TIMES = ["breakfast", "lunch", "merienda", "dinner", "late_night"] as const;
export type MealTime = (typeof MEAL_TIMES)[number];

export const MEAL_TIME_LABELS: Record<MealTime, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  merienda: "Merienda",
  dinner: "Dinner",
  late_night: "Late night",
};

/** Local clock → meal time (Philippine habits). The app passes the hour; the engine never reads the clock. */
export function mealTimeAt(hour: number, minute = 0): MealTime {
  const h = hour + minute / 60;
  if (h >= 5 && h < 10.5) return "breakfast";
  if (h >= 10.5 && h < 14.5) return "lunch";
  if (h >= 14.5 && h < 17.5) return "merienda";
  if (h >= 17.5 && h < 22) return "dinner";
  return "late_night";
}

type Rule = [(d: Dish) => boolean, number];
const s = (...keys: string[]) => (d: Dish) => keys.some((k) => (d.attributes[`structure:${k}`] ?? 0) >= 0.5);
const style = (...ss: Dish["style"][]) => (d: Dish) => ss.includes(d.style);
const rich = (min: number) => (d: Dish) => d.richness >= min;

const RULES: Record<MealTime, Rule[]> = {
  breakfast: [
    [s("silog"), 1],
    [s("porridge"), 0.9],
    [s("sandwich", "pancake"), 0.5],
    [s("rice_meal"), 0.15],
    [s("pizza", "burger", "curry", "stew", "casserole", "sizzling_plate", "grilled_plate", "pasta", "noodle_soup"), -0.5],
    [style("sharing", "rich_indulgent"), -0.5],
    [rich(0.85), -0.3],
  ],
  lunch: [
    [s("rice_bowl", "fried_rice", "silog"), 0.7],
    [s("rice_meal", "noodles", "noodle_soup", "sandwich", "wraps", "burger", "salad", "cutlet_plate", "sushi", "tacos", "curry"), 0.6],
    [s("grilled_plate", "pasta", "pizza", "soup", "stew"), 0.45],
    [s("sizzling_plate"), 0.4],
    [style("sharing"), -0.35],
    [rich(0.9), -0.2],
  ],
  merienda: [
    [s("street_snack", "dumplings", "rolls", "pancake"), 0.9],
    [s("noodles", "sandwich", "skewers", "wraps", "mezze", "tacos"), 0.5],
    [s("pizza", "burger", "porridge"), 0.3],
    [s("rice_meal", "rice_bowl", "stew", "curry", "grilled_plate", "roast_plate", "sizzling_plate", "casserole"), -0.4],
    [style("sharing", "hearty"), -0.4],
  ],
  dinner: [
    [s("stew", "curry", "sizzling_plate", "grilled_plate", "roast_plate"), 0.7],
    [style("sharing", "hearty", "rich_indulgent"), 0.6],
    [s("soup", "noodle_soup", "pasta", "pizza", "skewers", "risotto", "casserole", "rice_meal"), 0.5],
    [s("porridge"), -0.3],
    [s("silog"), -0.1],
    [s("street_snack", "pancake"), -0.3],
    [s("sandwich", "salad"), -0.2],
  ],
  late_night: [
    [s("noodle_soup", "silog", "street_snack", "porridge"), 0.7],
    [s("sizzling_plate", "burger", "skewers", "dumplings", "fried_rice"), 0.5],
    [s("salad", "steamed_plate"), -0.3],
    [style("sharing"), -0.2],
  ],
};

/** Suitability of a dish for a meal time, in [-1, 1]. Catalog overrides win. */
export function mealFit(dish: Dish, mt: MealTime): number {
  const override = dish.mealTimes?.[mt];
  if (typeof override === "number") return Math.max(-1, Math.min(1, override));
  let pos = 0;
  let neg = 0;
  for (const [test, v] of RULES[mt]) {
    if (!test(dish)) continue;
    if (v > 0) pos = Math.max(pos, v);
    else neg = Math.min(neg, v);
  }
  return Math.max(-1, Math.min(1, pos + neg));
}
