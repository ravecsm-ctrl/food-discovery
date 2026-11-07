import { describe, expect, it } from "vitest";
import type { ConfirmedMeal } from "@/engine";
import type { EvalSessionRecord } from "./local-store";
import { ratedMeals } from "./taste-data";

const meal = (id: string, rating?: number | null): ConfirmedMeal => ({ id, dishId: "dish-bulalo", consumedAt: "2026-11-06T12:00:00.000Z", confirmed: true, source: "manual", ...(rating !== undefined ? { rating } : {}) });
const session = (events: EvalSessionRecord["events"]) => ({ events }) as unknown as EvalSessionRecord;

describe("ratedMeals", () => {
  it("uses the meal's own rating, falls back to the latest session rating, and respects a cleared rating", () => {
    const sessions = [session([
      { type: "satisfaction_recorded", at: "2026-11-06T13:00:00.000Z", mealId: "b", rating: 2 },
      { type: "satisfaction_recorded", at: "2026-11-06T14:00:00.000Z", mealId: "b", rating: 4 },
      { type: "satisfaction_recorded", at: "2026-11-06T14:00:00.000Z", mealId: "c", rating: 5 },
    ])];
    const out = ratedMeals([meal("a", 5), meal("b"), meal("c", null), meal("d")], sessions);
    expect(out.map((r) => [r.meal.id, r.rating])).toEqual([["a", 5], ["b", 4]]);
  });
});
