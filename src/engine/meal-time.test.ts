/** Meal-time fit (v3 policies) — soft, explainable, never excludes a dish. */
import { describe, expect, it } from "vitest";
import { explainItem } from "./explain.ts";
import { MEAL_TIMES, mealFit, mealTimeAt } from "./meal-time.ts";
import { getPolicy } from "./policy.ts";
import { quickPicks, recommend } from "./recommend.ts";
import { scoringInputs, selectNextCard } from "./selection.ts";
import { scoreDish } from "./scoring.ts";
import { addExposure, recordReaction, type DiscoverySession } from "./session.ts";
import { catalog, deps, meal, newSession, NOW } from "./test-helpers.ts";
import type { MealTime } from "./meal-time.ts";

const dish = (id: string) => catalog.byId.get(id)!;
const session = (policy: string, mealTime: MealTime, seed = 7) => newSession(policy, seed, { mealTime });

describe("meal times", () => {
  it("follows Philippine meal habits by clock", () => {
    expect([6, 10, 11, 14, 15, 17, 18, 21, 23, 2].map((h) => mealTimeAt(h))).toEqual([
      "breakfast", "breakfast", "lunch", "lunch", "merienda", "merienda", "dinner", "dinner", "late_night", "late_night",
    ]);
    expect(mealTimeAt(10, 30)).toBe("lunch");
  });

  it("rates dishes sensibly, with local exceptions", () => {
    expect(mealFit(dish("dish-tapsilog"), "breakfast")).toBe(1);
    expect(mealFit(dish("dish-tapsilog"), "breakfast")).toBeGreaterThan(mealFit(dish("dish-tapsilog"), "dinner"));
    expect(mealFit(dish("dish-crispy-pata"), "breakfast")).toBeLessThan(-0.25);
    expect(mealFit(dish("dish-crispy-pata"), "dinner")).toBeGreaterThan(0.5);
    expect(mealFit(dish("dish-pancit-canton"), "merienda")).toBeGreaterThan(0.6);
    expect(mealFit(dish("dish-pork-sisig"), "late_night")).toBeGreaterThan(0.6);
    expect(mealFit(dish("dish-potato-gnocchi"), "merienda")).toBeLessThan(0);
    for (const mt of MEAL_TIMES) for (const d of catalog.dishes) expect(Math.abs(mealFit(d, mt))).toBeLessThanOrEqual(1);
  });

  it("every meal time has plenty of good fits (catalog-v0.6 filled the breakfast gap)", () => {
    for (const mt of MEAL_TIMES) expect(catalog.dishes.filter((d) => mealFit(d, mt) >= 0.4).length, mt).toBeGreaterThanOrEqual(25);
  });
});

describe("v3 scoring and card order", () => {
  it("adds weight × fit to utility in v3; v2 ignores meal time", () => {
    const s3 = session("adaptive-v3", "breakfast");
    const s2 = session("adaptive-v2", "breakfast");
    const w = getPolicy("adaptive-v3").mealTime.weight;
    const a = scoreDish(dish("dish-tapsilog"), scoringInputs(s3, deps("adaptive-v3")));
    const b = scoreDish(dish("dish-tapsilog"), scoringInputs(s2, deps("adaptive-v2")));
    expect(a.mealFit).toBe(1);
    expect(b.mealFit).toBe(0);
    expect(a.utility - b.utility).toBeCloseTo(w, 6);
  });

  for (const policy of ["adaptive-v3", "baseline-fixed-v3"]) {
    it(`${policy}: breakfast cards start with breakfast-style dishes; unsuitable ones wait but are never excluded`, () => {
      let s: DiscoverySession = session(policy, "breakfast");
      const d = deps(policy);
      const shown: string[] = [];
      for (;;) {
        const next = selectNextCard(s, d);
        if (!next) break;
        shown.push(next.dishId);
        s = recordReaction(addExposure(s, next.dishId, NOW), "no", NOW);
      }
      expect(shown).toHaveLength(catalog.dishes.length); // nothing excluded
      for (const id of shown.slice(0, 3)) expect(mealFit(dish(id), "breakfast")).toBeGreaterThanOrEqual(0.4);
      const firstDemoted = shown.findIndex((id) => mealFit(dish(id), "breakfast") < -0.25);
      const lastOk = shown.map((id) => mealFit(dish(id), "breakfast") >= -0.25).lastIndexOf(true);
      expect(firstDemoted).toBeGreaterThan(lastOk);
    });
  }

  it("explains a good fit, and only for v3", () => {
    let s = session("adaptive-v3", "dinner");
    for (const id of ["dish-bulalo", "dish-kare-kare", "dish-beef-caldereta"]) s = recordReaction(addExposure(s, id, NOW), "yes", NOW);
    const run = recommend(s, deps("adaptive-v3"));
    const item = run.items.find((i) => i.reasonCodes.includes("MEAL_TIME_FIT"));
    expect(item).toBeDefined();
    expect(explainItem(item!, catalog).map((e) => e.text)).toContain("A good fit for dinner.");
    let s2 = session("adaptive-v2", "dinner");
    for (const id of ["dish-bulalo", "dish-kare-kare", "dish-beef-caldereta"]) s2 = recordReaction(addExposure(s2, id, NOW), "yes", NOW);
    expect(recommend(s2, deps("adaptive-v2")).items.flatMap((i) => i.reasonCodes)).not.toContain("MEAL_TIME_FIT");
  });

  it("tonight's swipes still win: a clear 'yes' to a dinner dish at breakfast is still recommended", () => {
    let s = session("adaptive-v3", "breakfast");
    for (const id of ["dish-kare-kare", "dish-beef-caldereta", "dish-crispy-pata"]) s = recordReaction(addExposure(s, id, NOW), "yes", NOW);
    for (const id of ["dish-tapsilog", "dish-arroz-caldo"]) s = recordReaction(addExposure(s, id, NOW), "no", NOW);
    const ids = recommend(s, deps("adaptive-v3")).items.map((i) => i.dishId);
    expect(ids.some((id) => ["dish-kare-kare", "dish-beef-caldereta", "dish-crispy-pata"].includes(id))).toBe(true);
  });

  it("quick picks suit the meal too", () => {
    const meals = [meal("m1", "dish-chicken-adobo", 14), meal("m2", "dish-bulalo", 30)];
    const run = quickPicks(session("adaptive-v3", "breakfast"), deps("adaptive-v3", { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 }));
    expect(run.items.length).toBeGreaterThan(0);
    for (const i of run.items) expect(mealFit(dish(i.dishId), "breakfast")).toBeGreaterThanOrEqual(-0.25);
  });
});
