/** Strong preferences — "Love it" / "Not for a while" / "Never show again" (owner request 2026-11-07). */
import { describe, expect, it } from "vitest";
import { buildCandidates, DEFAULT_CONSTRAINTS } from "./eligibility.ts";
import { explainItem } from "./explain.ts";
import { recommend } from "./recommend.ts";
import { EMPTY_USER, scoreDish } from "./scoring.ts";
import { scoringInputs, selectNextCard } from "./selection.ts";
import { activePrefs, favouriteDishIds, hiddenDishIds, snoozeUntil, STRONG_PREFS_V0, type StrongPreference } from "./strong-prefs.ts";
import { tasteProfile } from "./taste.ts";
import { catalog, deps, newSession, NOW, reactTo } from "./test-helpers.ts";

const daysFromNow = (d: number) => new Date(Date.parse(NOW) + d * 86_400_000).toISOString();
const fav = (dishId: string, at = NOW): StrongPreference => ({ dishId, kind: "favourite", at });
const snooze = (dishId: string, at = NOW): StrongPreference => ({ dishId, kind: "snooze", at, until: snoozeUntil(at) });
const never = (dishId: string, at = NOW): StrongPreference => ({ dishId, kind: "never", at });

describe("strong preferences", () => {
  it("a snooze hides a dish for 30 days, then it can come back; never stays hidden", () => {
    const prefs = [snooze("dish-dinuguan"), never("dish-pork-adobo")];
    expect(hiddenDishIds(prefs, NOW)).toEqual(["dish-dinuguan", "dish-pork-adobo"]);
    expect(hiddenDishIds(prefs, daysFromNow(STRONG_PREFS_V0.snoozeDays - 1))).toContain("dish-dinuguan");
    expect(hiddenDishIds(prefs, daysFromNow(STRONG_PREFS_V0.snoozeDays + 1))).toEqual(["dish-pork-adobo"]);
  });

  it("one preference per dish: the latest wins", () => {
    const prefs = [fav("dish-sinigang", NOW), snooze("dish-sinigang", daysFromNow(1))];
    expect(activePrefs(prefs, daysFromNow(2)).map((p) => p.kind)).toEqual(["snooze"]);
    expect(favouriteDishIds(prefs, daysFromNow(2))).toEqual([]);
  });

  it("hidden dishes are never shown or recommended, and are not counted as dietary exclusions", () => {
    const hidden = ["dish-chicken-adobo", "dish-pork-sinigang"];
    const s = newSession("adaptive-v3", 7, { hiddenDishIds: hidden });
    const c = buildCandidates(catalog, s.constraints);
    expect(c.hiddenByYou).toBe(2);
    expect(c.excluded).toEqual([]);
    expect(c.eligible.some((d) => hidden.includes(d.id))).toBe(false);
    const d = deps("adaptive-v3");
    expect(hidden).not.toContain(selectNextCard(s, d)?.dishId);
    expect(recommend(s, d).runReasonCodes).not.toContain("HARD_CONSTRAINT_EXCLUDED");
  });

  it("favourites shape long-term taste at half the weight of an eaten 5★ meal; hidden dishes nudge similar ones down", () => {
    const favs = tasteProfile(catalog, [], NOW, [fav("dish-chicken-pho"), fav("dish-bulalo")]);
    expect(favs.favourites).toBe(2);
    expect(favs.weights["texture:brothy"]).toBeGreaterThan(0);
    const eaten = tasteProfile(catalog, [
      { meal: { id: "1", dishId: "dish-chicken-pho", consumedAt: NOW, confirmed: true, source: "manual" }, rating: 5 },
      { meal: { id: "2", dishId: "dish-bulalo", consumedAt: NOW, confirmed: true, source: "manual" }, rating: 5 },
    ], NOW);
    expect(favs.weights["texture:brothy"]!).toBeLessThan(eaten.weights["texture:brothy"]!);

    const hid = tasteProfile(catalog, [], NOW, [snooze("dish-chicken-pho"), never("dish-bulalo")]);
    expect(hid.hidden).toBe(2);
    expect(hid.weights["texture:brothy"]).toBeLessThan(0);
    expect(Math.abs(hid.weights["texture:brothy"]!)).toBeLessThan(favs.weights["texture:brothy"]!);
    // An expired snooze teaches nothing any more.
    expect(tasteProfile(catalog, [], daysFromNow(40), [snooze("dish-chicken-pho"), snooze("dish-bulalo")]).weights).toEqual({});
  });

  it("without strong preferences the profile is unchanged (taste-v1 = taste-v0)", () => {
    const r = [
      { meal: { id: "1", dishId: "dish-chicken-pho", consumedAt: NOW, confirmed: true as const, source: "manual" as const }, rating: 5 },
      { meal: { id: "2", dishId: "dish-bulalo", consumedAt: NOW, confirmed: true as const, source: "manual" as const }, rating: 4 },
    ];
    expect(tasteProfile(catalog, r, NOW, []).weights).toEqual(tasteProfile(catalog, r, NOW).weights);
  });

  it("a super like moves tonight's appetite more than an ordinary yes (explicit strength)", () => {
    const d = deps("adaptive-v3");
    const ord = scoringInputs(reactTo(newSession("adaptive-v3"), "dish-chicken-pho", "yes"), d);
    const sup = scoringInputs(reactTo(newSession("adaptive-v3"), "dish-chicken-pho", "yes", "explicit"), d);
    const target = catalog.byId.get("dish-beef-pho")!;
    expect(scoreDish(target, sup).utility).toBeGreaterThanOrEqual(scoreDish(target, ord).utility);
    const ordNo = scoringInputs(reactTo(newSession("adaptive-v3"), "dish-chicken-pho", "no"), d);
    const supNo = scoringInputs(reactTo(newSession("adaptive-v3"), "dish-chicken-pho", "no", "explicit"), d);
    expect(scoreDish(target, supNo).utility).toBeLessThanOrEqual(scoreDish(target, ordNo).utility);
  });

  it("a saved favourite is explained as one — from the saved choice, nothing invented", () => {
    const favourites = ["dish-chicken-pho"];
    const user = { ...EMPTY_USER, favouriteDishIds: favourites, stableAttributeWeights: tasteProfile(catalog, [], NOW, favourites.map((id) => fav(id))).weights };
    const s = reactTo(reactTo(reactTo(newSession("adaptive-v3", 3, DEFAULT_CONSTRAINTS), "dish-chicken-pho", "yes", "explicit"), "dish-pork-adobo", "no"), "dish-dinuguan", "no");
    const run = recommend(s, deps("adaptive-v3", user));
    const item = run.items.find((i) => i.dishId === "dish-chicken-pho");
    expect(item?.reasonCodes).toContain("SAVED_FAVOURITE");
    expect(explainItem(item!, catalog).map((e) => e.text)).toContain("One of your favourites.");
    for (const other of run.items.filter((i) => i.dishId !== "dish-chicken-pho")) expect(other.reasonCodes).not.toContain("SAVED_FAVOURITE");
  });
});
