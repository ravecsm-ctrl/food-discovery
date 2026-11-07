/**
 * Gathers the evidence for the long-term taste profile: meals with a star rating. A rating can live on
 * the meal itself (rated in "Your data") or, for older meals, in the session's satisfaction event.
 * The meal's own rating wins. Pure, so it is unit-testable.
 */
import type { ConfirmedMeal, RatedMeal } from "@/engine";
import type { EvalSessionRecord } from "./local-store";

export function ratedMeals(meals: readonly ConfirmedMeal[], sessions: readonly EvalSessionRecord[]): RatedMeal[] {
  const fromEvents = new Map<string, { rating: number; at: string }>();
  for (const s of sessions) {
    for (const e of s.events) {
      if (e.type !== "satisfaction_recorded") continue;
      const prev = fromEvents.get(e.mealId);
      if (!prev || e.at > prev.at) fromEvents.set(e.mealId, { rating: e.rating, at: e.at });
    }
  }
  const out: RatedMeal[] = [];
  for (const meal of meals) {
    // null = the person cleared their rating (no fallback); undefined = never rated on the meal itself.
    const rating = meal.rating !== undefined ? meal.rating : (fromEvents.get(meal.id)?.rating ?? null);
    if (rating !== null && rating >= 1 && rating <= 5) out.push({ meal, rating });
  }
  return out;
}
