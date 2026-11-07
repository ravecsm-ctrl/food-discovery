/** Long-term taste from rated meals — PRRD R-008, R-016; ETD §8.3 (taste-v0). */
import { describe, expect, it } from "vitest";
import { explainItem } from "./explain.ts";
import { recommend } from "./recommend.ts";
import { TASTE_V0, tasteHighlights, tasteProfile, type RatedMeal } from "./taste.ts";
import { catalog, deps, meal, newSession, NOW, reactTo } from "./test-helpers.ts";

const rated = (id: string, dishId: string | null, rating: number, daysAgo = 2, extra = {}): RatedMeal => ({ meal: { ...meal(id, dishId, daysAgo * 24), ...extra }, rating });
const BROTHY_LOVE = [rated("1", "dish-chicken-pho", 5), rated("2", "dish-bulalo", 5), rated("3", "dish-tonkotsu-ramen", 5), rated("4", "dish-beef-pho", 4)];

describe("tasteProfile", () => {
  it("learns likes from highly rated meals and nothing from fewer than the minimum", () => {
    expect(tasteProfile(catalog, BROTHY_LOVE.slice(0, 1), NOW).weights).toEqual({});
    const p = tasteProfile(catalog, BROTHY_LOVE, NOW);
    expect(p.ratedMeals).toBe(4);
    expect(p.weights["texture:brothy"]).toBeGreaterThan(0.3);
    expect(p.weights["texture:crispy"]).toBeUndefined();
    expect(tasteHighlights(p).likes).toContain("texture:brothy");
  });

  it("dislikes count half as much as likes; a 3★ meal is neutral; staples are ignored", () => {
    const likes = tasteProfile(catalog, [rated("a", "dish-fettuccine-alfredo", 5), rated("b", "dish-mac-and-cheese", 5)], NOW).weights["texture:creamy"]!;
    const dislikes = tasteProfile(catalog, [rated("a", "dish-fettuccine-alfredo", 1), rated("b", "dish-mac-and-cheese", 1)], NOW).weights["texture:creamy"]!;
    expect(dislikes).toBeLessThan(0);
    expect(Math.abs(dislikes)).toBeCloseTo(likes * TASTE_V0.negativeDamping, 6);
    expect(tasteProfile(catalog, [rated("a", "dish-bulalo", 3), rated("b", "dish-chicken-pho", 3)], NOW).weights).toEqual({});
    expect(tasteProfile(catalog, BROTHY_LOVE, NOW).weights["ingredient:rice"]).toBeUndefined();
  });

  it("old ratings fade; thin evidence stays weak; unrated or undescribed meals teach nothing", () => {
    const recent = tasteProfile(catalog, BROTHY_LOVE, NOW).weights["texture:brothy"]!;
    const old = tasteProfile(catalog, BROTHY_LOVE.map((r) => ({ ...r, meal: { ...r.meal, consumedAt: new Date(Date.parse(NOW) - 240 * 86_400_000).toISOString() } })), NOW).weights["texture:brothy"]!;
    expect(old).toBeLessThan(recent / 4);
    const two = tasteProfile(catalog, BROTHY_LOVE.slice(0, 2), NOW).weights["texture:brothy"]!;
    expect(two).toBeLessThan(recent);
    expect(tasteProfile(catalog, [rated("x", null, 5, 1, { unrecognizedName: "Mystery" }), rated("y", null, 5, 1, { unrecognizedName: "Other" })], NOW).ratedMeals).toBe(0);
  });

  it("uses your own described dishes", () => {
    const kebab = { cuisine: "middle_eastern", mains: ["beef"], method: "grilled", type: "wraps", flavors: ["flavor:garlicky"] };
    const p = tasteProfile(catalog, [rated("k1", null, 5, 1, { unrecognizedName: "Kebab", ownDish: kebab }), rated("k2", null, 5, 3, { unrecognizedName: "Kebab", ownDish: kebab })], NOW);
    expect(p.weights["cuisine:middle_eastern"]).toBeGreaterThan(0);
    expect(p.weights["method:grilled"]).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(tasteProfile(catalog, BROTHY_LOVE, NOW)).toEqual(tasteProfile(catalog, [...BROTHY_LOVE].reverse(), NOW));
  });
});

describe("taste in recommendations (R-008: stable ≠ current)", () => {
  it("rated likes lift similar dishes and are explained from evidence", () => {
    const weights = tasteProfile(catalog, BROTHY_LOVE, NOW).weights;
    let s = newSession("adaptive-v2");
    s = reactTo(s, "dish-margherita-pizza", "yes");
    s = reactTo(s, "dish-kimchi-jjigae", "yes");
    const plain = recommend(s, deps("adaptive-v2"));
    const withTaste = recommend(s, deps("adaptive-v2", { stableAttributeWeights: weights, confirmedMeals: [], noveltyPreference: 0.5 }));
    const brothyShare = (r: typeof plain) => r.items.filter((i) => (catalog.byId.get(i.dishId)!.attributes["texture:brothy"] ?? 0) >= 0.5).length;
    expect(brothyShare(withTaste)).toBeGreaterThanOrEqual(brothyShare(plain));
    const stableItem = withTaste.items.find((i) => i.reasonCodes.includes("STABLE_PREFERENCE_MATCH"));
    expect(stableItem).toBeDefined();
    expect(explainItem(stableItem!, catalog).map((e) => e.text).join(" ")).toMatch(/You've liked .* dishes before\./);
  });

  it("tonight's swipes still win over long-term taste (current weight > stable weight)", () => {
    const weights = tasteProfile(catalog, BROTHY_LOVE, NOW).weights;
    let s = newSession("adaptive-v2");
    for (const id of ["dish-chicken-pho", "dish-bulalo", "dish-beef-pho"]) s = reactTo(s, id, "no");
    s = reactTo(s, "dish-korean-fried-chicken", "yes");
    s = reactTo(s, "dish-chicken-karaage", "yes");
    const run = recommend(s, deps("adaptive-v2", { stableAttributeWeights: weights, confirmedMeals: [], noveltyPreference: 0.5 }));
    expect(run.items[0] && (catalog.byId.get(run.items[0].dishId)!.attributes["method:fried"] ?? 0)).toBeGreaterThan(0);
  });
});
