/** Library step 2 — your own described dishes (PRRD §9.4, R-015, R-012). */
import { describe, expect, it } from "vitest";
import { dishFatigue, FATIGUE_V2, recentLoad } from "./fatigue.ts";
import { cleanOwnDish, ownDishFeatures, ownDishSummary, type OwnDish } from "./own-dish.ts";
import { catalog, meal, NOW } from "./test-helpers.ts";

const kebab: OwnDish = { cuisine: "middle_eastern", mains: ["beef"], method: "grilled", type: "wraps", flavors: ["flavor:garlicky", "flavor:spiced"] };

describe("describing a dish", () => {
  it("keeps only the fixed choices and their limits", () => {
    expect(cleanOwnDish({ cuisine: "martian", mains: ["beef", "pork", "chicken", "beef"], method: "teleported", flavors: ["flavor:spicy", "x", "flavor:sweet", "flavor:sour", "flavor:smoky"] })).toEqual({
      cuisine: null,
      mains: ["beef", "pork"],
      method: null,
      type: null,
      flavors: ["flavor:spicy", "flavor:sweet", "flavor:sour"],
    });
    expect(cleanOwnDish({})).toBeNull();
    expect(cleanOwnDish(null)).toBeNull();
  });

  it("turns a description into catalog-style features and a readable summary", () => {
    expect(ownDishFeatures(kebab)).toEqual({
      cuisine: "middle_eastern",
      attributes: { "ingredient:beef": 1, "method:grilled": 1, "structure:wraps": 1, "flavor:garlicky": 0.8, "flavor:spiced": 0.8 },
    });
    expect(ownDishFeatures({ ...kebab, method: "fried", type: "soup" }).attributes).toMatchObject({ "texture:crispy": 0.6, "texture:brothy": 0.8 });
    expect(ownDishSummary(kebab)).toBe("Middle Eastern · grilled · beef · wrap · garlicky · warmly spiced");
  });
});

describe("taste fatigue from your own dishes (R-012)", () => {
  it("a described meal counts toward variety; an undescribed one only counts as 'a meal happened'", () => {
    const described = { ...meal("k1", null, 5), unrecognizedName: "Kebab", ownDish: kebab };
    const bare = { ...meal("k2", null, 5), unrecognizedName: "Kebab" };
    const withDesc = recentLoad(catalog, [described], NOW, FATIGUE_V2);
    const withoutDesc = recentLoad(catalog, [bare], NOW, FATIGUE_V2);
    expect(withDesc.mealsInWindow).toBe(1);
    expect(withoutDesc.mealsInWindow).toBe(1);
    expect(withoutDesc.load.size).toBe(0);
    const similar = catalog.byId.get("dish-beef-kebab-plate")!;
    const unrelated = catalog.byId.get("dish-chicken-pho")!;
    expect(dishFatigue(similar, withDesc, FATIGUE_V2)).toBeGreaterThan(dishFatigue(unrelated, withDesc, FATIGUE_V2));
    expect(dishFatigue(similar, withDesc, FATIGUE_V2)).toBeGreaterThan(0.2);
  });

  it("ignores a description on a meal that already names a catalog dish, and malformed descriptions", () => {
    const listed = { ...meal("p1", "dish-chicken-pho", 5), ownDish: kebab };
    expect(recentLoad(catalog, [listed], NOW, FATIGUE_V2).load.has("ingredient:beef")).toBe(false);
    const junk = { ...meal("j1", null, 5), unrecognizedName: "Mystery", ownDish: { cuisine: "??", mains: ["unobtainium"] } as unknown as OwnDish };
    expect(recentLoad(catalog, [junk], NOW, FATIGUE_V2).load.size).toBe(0);
  });
});
