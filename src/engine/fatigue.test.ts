import { describe, expect, it } from "vitest";
import {
  FATIGUE_V2,
  dishFatigue,
  explainItem,
  fatigueAdjustment,
  quickPicks,
  recentLoad,
  recommend,
  scoreDish,
  type UserModel,
} from "./index.ts";
import { scoringInputs } from "./selection.ts";
import { catalog, deps, meal, newSession, reactTo } from "./test-helpers.ts";

const dish = (id: string) => catalog.byId.get(id)!;
const user = (meals: ReturnType<typeof meal>[], varietySeeking = 1): UserModel => ({
  stableAttributeWeights: {},
  confirmedMeals: meals,
  noveltyPreference: 0.5,
  varietySeeking,
});
const FRIED_WEEK = [meal("m1", "dish-lechon-kawali", 3), meal("m2", "dish-korean-fried-chicken", 20), meal("m3", "dish-pork-tonkatsu", 28)];
const fatigueOf = (id: string, meals: ReturnType<typeof meal>[]) =>
  dishFatigue(dish(id), recentLoad(catalog, meals, deps().now, FATIGUE_V2), FATIGUE_V2);

describe("taste fatigue v2 (R-012, D-09)", () => {
  it("is zero with no confirmed meals — missing history is unknown, not 'not eaten'", () => {
    for (const d of catalog.dishes) expect(fatigueOf(d.id, [])).toBe(0);
    const s = scoreDish(dish("dish-pork-tonkatsu"), scoringInputs(newSession("adaptive-v2"), deps("adaptive-v2")));
    expect(s.exposureAdjustment).toBe(0);
  });

  it("recently eaten qualities raise fatigue for similar dishes, not different ones", () => {
    expect(fatigueOf("dish-chicken-karaage", FRIED_WEEK)).toBeGreaterThan(0.5);
    expect(fatigueOf("dish-chicken-pho", FRIED_WEEK)).toBeLessThan(0.2);
    expect(fatigueOf("dish-chicken-karaage", FRIED_WEEK)).toBeGreaterThan(fatigueOf("dish-chicken-pho", FRIED_WEEK));
  });

  it("recovers over time (about a 1-day half-life) and ignores meals older than the window", () => {
    const fresh = fatigueOf("dish-chicken-karaage", [meal("a", "dish-pork-tonkatsu", 2)]);
    const dayOld = fatigueOf("dish-chicken-karaage", [meal("a", "dish-pork-tonkatsu", 26)]);
    expect(dayOld).toBeLessThan(fresh);
    expect(dayOld).toBeGreaterThan(fresh * 0.35);
    expect(fatigueOf("dish-chicken-karaage", [meal("a", "dish-pork-tonkatsu", 24 * 5)])).toBe(0);
  });

  it("staples (rice, 'savory') never drive fatigue", () => {
    expect(FATIGUE_V2.exempt).toEqual(expect.arrayContaining(["ingredient:rice", "flavor:savory"]));
    const load = recentLoad(catalog, [meal("a", "dish-chicken-adobo", 2)], deps().now, FATIGUE_V2);
    expect(load.load.has("ingredient:rice")).toBe(false);
    expect(load.load.has("flavor:savory")).toBe(false);
  });

  it("duplicate meal ids count once", () => {
    const one = fatigueOf("dish-chicken-karaage", [meal("a", "dish-pork-tonkatsu", 2)]);
    const dup = fatigueOf("dish-chicken-karaage", [meal("a", "dish-pork-tonkatsu", 2), meal("a", "dish-pork-tonkatsu", 2)]);
    expect(dup).toBe(one);
  });

  it("penalty is bounded, scales with coverage and variety-seeking, and tonight's 'yes' damps it", () => {
    const load = recentLoad(catalog, FRIED_WEEK, deps().now, FATIGUE_V2);
    const full = fatigueAdjustment(1, load, FATIGUE_V2, 0, 1);
    expect(full).toBeCloseTo(-0.15, 6);
    expect(fatigueAdjustment(1, load, FATIGUE_V2, 0, 0.5)).toBeCloseTo(-0.075, 6);
    expect(fatigueAdjustment(1, load, FATIGUE_V2, 0.8, 1)).toBeCloseTo(-0.03, 6);
    const oneMeal = recentLoad(catalog, [FRIED_WEEK[0]!], deps().now, FATIGUE_V2);
    expect(fatigueAdjustment(1, oneMeal, FATIGUE_V2, 0, 1)).toBeCloseTo(-0.05, 6);
  });

  it("a dish you said 'sounds good' to tonight still wins despite recent repeats (PRRD §10.4)", () => {
    const d = deps("adaptive-v2", user(FRIED_WEEK));
    let s = newSession("adaptive-v2");
    s = reactTo(s, "dish-chicken-karaage", "yes");
    s = reactTo(s, "dish-chicken-pho", "no");
    const run = recommend(s, d);
    expect(run.items[0]?.dishId).toBe("dish-chicken-karaage");
  });

  it("fatigue reorders otherwise-equal options towards variety", () => {
    let s = newSession("adaptive-v2");
    s = reactTo(s, "dish-chicken-karaage", "yes");
    s = reactTo(s, "dish-chicken-pho", "yes");
    const withMeals = recommend(s, deps("adaptive-v2", user(FRIED_WEEK))).items.map((i) => i.dishId);
    const without = recommend(s, deps("adaptive-v2")).items.map((i) => i.dishId);
    expect(withMeals.indexOf("dish-chicken-pho")).toBeLessThanOrEqual(without.indexOf("dish-chicken-pho"));
    const pho = recommend(s, deps("adaptive-v2", user(FRIED_WEEK))).items.find((i) => i.dishId === "dish-chicken-pho")!;
    expect(pho.reasonCodes).toContain("RECENT_FOOD_VARIETY");
    expect(explainItem(pho, catalog).map((e) => e.text).join(" ")).toMatch(/A change from the .*fried.* you've had recently\./);
  });
});

describe("quick picks from recent meals (D-10)", () => {
  it("no recent meals → no quick picks (nothing to base them on)", () => {
    const run = quickPicks(newSession("adaptive-v2"), deps("adaptive-v2"));
    expect(run.noMatch).toBe(true);
    expect(run.items).toEqual([]);
  });

  it("three meals → up to 3 fresh, diverse, honestly-labelled picks", () => {
    const d = deps("adaptive-v2", user(FRIED_WEEK));
    const run = quickPicks(newSession("adaptive-v2"), d);
    expect(run.source).toBe("quick_picks");
    expect(run.kind).toBe("tentative");
    expect(run.items.length).toBe(3);
    const ids = run.items.map((i) => i.dishId);
    for (const eaten of ["dish-lechon-kawali", "dish-korean-fried-chicken", "dish-pork-tonkatsu"]) expect(ids).not.toContain(eaten);
    const load = recentLoad(catalog, FRIED_WEEK, d.now, FATIGUE_V2);
    for (const id of ids) {
      expect(dishFatigue(dish(id), load, FATIGUE_V2)).toBeLessThanOrEqual(FATIGUE_V2.freshMax);
      expect(dish(id).attributes["method:fried"] ?? 0).toBeLessThan(0.6);
    }
    expect(new Set(ids.map((id) => dish(id).style)).size).toBe(3);
    for (const item of run.items) {
      expect(item.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
      const texts = explainItem(item, catalog, "quick_picks").map((e) => e.text);
      expect(texts).toContain("Based only on your recent meals — swipe to refine.");
      expect(texts.join(" ")).not.toMatch(/you liked/);
    }
  });

  it("respects hard dietary exclusions", () => {
    const d = deps("adaptive-v2", user(FRIED_WEEK));
    for (let seed = 0; seed < 10; seed++) {
      const run = quickPicks(newSession("adaptive-v2", seed, { avoidedIngredients: ["shellfish", "chicken"] }), d);
      for (const item of run.items) {
        const claims = dish(item.dishId).ingredients.filter((c) => ["shellfish", "chicken"].includes(c.key) && c.presence === "confirmed_present");
        expect(claims).toEqual([]);
      }
    }
  });

  it("is deterministic for the same inputs and seed", () => {
    const d = deps("adaptive-v2", user(FRIED_WEEK));
    expect(quickPicks(newSession("adaptive-v2", 7), d)).toEqual(quickPicks(newSession("adaptive-v2", 7), d));
  });

  it("unrecognized meals count toward coverage without inventing attributes", () => {
    const meals = [{ ...meal("u1", null, 3), unrecognizedName: "Lola's special" }];
    const load = recentLoad(catalog, meals, deps().now, FATIGUE_V2);
    expect(load.mealsInWindow).toBe(1);
    expect(load.load.size).toBe(0);
    expect(quickPicks(newSession("adaptive-v2"), deps("adaptive-v2", user(meals))).items).toEqual([]);
  });
});

describe("card selection with recent meals", () => {
  it("dishes eaten recently are not shown first, in either card policy (both arms comparable)", async () => {
    const { runPolicy } = await import("./test-helpers.ts");
    const meals = [meal("m1", "dish-lechon-kawali", 14), meal("m2", "dish-korean-fried-chicken", 24), meal("m3", "dish-pork-tonkatsu", 3)];
    for (const policyId of ["baseline-fixed-v2", "adaptive-v2"]) {
      for (let seed = 0; seed < 5; seed++) {
        const { shown } = runPolicy(newSession(policyId, seed), deps(policyId, user(meals)), 10, () => "no");
        for (const eaten of ["dish-lechon-kawali", "dish-korean-fried-chicken", "dish-pork-tonkatsu"]) expect(shown).not.toContain(eaten);
      }
    }
  });

  it("adaptive cold-start cards avoid heavily fatigued dishes", async () => {
    const { runPolicy } = await import("./test-helpers.ts");
    const d = deps("adaptive-v2", user(FRIED_WEEK));
    const load = recentLoad(catalog, FRIED_WEEK, d.now, FATIGUE_V2);
    const { shown } = runPolicy(newSession("adaptive-v2"), d, 3, () => "yes");
    for (const id of shown) expect(dishFatigue(dish(id), load, FATIGUE_V2)).toBeLessThanOrEqual(0.5);
  });

  it("recently eaten dishes still appear once fresher options run out", async () => {
    const { runPolicy } = await import("./test-helpers.ts");
    const { shown } = runPolicy(newSession("adaptive-v2"), deps("adaptive-v2", user(FRIED_WEEK)), catalog.dishes.length, () => "no");
    expect(shown).toContain("dish-lechon-kawali");
    expect(shown.length).toBe(catalog.dishes.length);
  });
});

describe("routine-lovers", () => {
  it("'I like routine' keeps recently eaten dishes in normal card order", async () => {
    const { runPolicy } = await import("./test-helpers.ts");
    const meals = [meal("m1", "dish-lechon-kawali", 14)];
    const normal = runPolicy(newSession("baseline-fixed-v2"), deps("baseline-fixed-v2", user(meals, 1)), catalog.dishes.length, () => "no").shown;
    const routine = runPolicy(newSession("baseline-fixed-v2"), deps("baseline-fixed-v2", user(meals, 0.5)), catalog.dishes.length, () => "no").shown;
    const plain = runPolicy(newSession("baseline-fixed-v2"), deps("baseline-fixed-v2"), catalog.dishes.length, () => "no").shown;
    expect(routine).toEqual(plain);
    expect(normal.indexOf("dish-lechon-kawali")).toBeGreaterThan(plain.indexOf("dish-lechon-kawali"));
  });
});
