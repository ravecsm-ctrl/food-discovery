/** Together Mode on one phone — PRRD J-03, R-002, R-011, R-022 · AT-013, AT-014 · ETD §8.10. */
import { describe, expect, it } from "vitest";
import { explainItem } from "./explain.ts";
import { recommend, readiness } from "./recommend.ts";
import { scoringInputs, selectNextCard } from "./selection.ts";
import { activeReactions, addExposure, canUndo, createSession, effectiveCardCount, recordReaction, recordSplitReaction, undoLastReaction, type DiscoverySession, type TogetherMeal } from "./session.ts";
import { JOINT_V0, jointScore, participantUsers } from "./together.ts";
import { EMPTY_USER } from "./scoring.ts";
import { DEFAULT_CONSTRAINTS } from "./eligibility.ts";
import { catalog, deps, meal, NOW } from "./test-helpers.ts";
import type { RestrictionKey } from "./types.ts";

const POLICY = "adaptive-v2";
const names = { a: "Rave", b: "Sam" };

function together(avoid: RestrictionKey[] = [], togetherMeals: TogetherMeal[] = []): DiscoverySession {
  return createSession({
    sessionId: "t1",
    seed: 7,
    policyId: POLICY,
    catalogVersion: catalog.catalogVersion,
    constraints: { ...DEFAULT_CONSTRAINTS, avoidedIngredients: avoid },
    now: NOW,
    initialBudget: 10,
    mode: "together",
    togetherMeals,
  });
}
const ate = (id: string, dishId: string, hoursAgo: number, who: TogetherMeal["who"]): TogetherMeal => ({ ...meal(id, dishId, hoursAgo), who });
const shared = (s: DiscoverySession, dishId: string, v: "yes" | "no") => recordReaction(addExposure(s, dishId, NOW), v, NOW);
const split = (s: DiscoverySession, dishId: string, wantedBy: "a" | "b") => recordSplitReaction(addExposure(s, dishId, NOW), wantedBy, NOW);

describe("recording reactions (AT-013, AT-014)", () => {
  it("a shared reaction is ONE unattributed reaction — never two individual Yes reactions", () => {
    const s = shared(together(), "dish-chicken-pho", "yes");
    expect(activeReactions(s)).toHaveLength(1);
    expect(activeReactions(s)[0]).toMatchObject({ value: "yes" });
    expect(activeReactions(s)[0]!.participant).toBeUndefined();
    expect(effectiveCardCount(s)).toBe(1);
  });

  it("a disagreement keeps each person's reaction, attributed, as one card and one undo step", () => {
    const s = split(together(), "dish-pork-tonkatsu", "a");
    expect(activeReactions(s).map((r) => [r.participant, r.value])).toEqual([
      ["a", "yes"],
      ["b", "no"],
    ]);
    expect(new Set(activeReactions(s).map((r) => r.actionGroupId)).size).toBe(1);
    expect(effectiveCardCount(s)).toBe(1);
    const undone = undoLastReaction(s, NOW);
    expect(activeReactions(undone)).toEqual([]);
    expect(canUndo(undone)).toBe(false);
  });

  it("disagreement is only possible in Together Mode", () => {
    const solo = createSession({ sessionId: "s", seed: 1, policyId: POLICY, catalogVersion: catalog.catalogVersion, constraints: DEFAULT_CONSTRAINTS, now: NOW, initialBudget: 10 });
    expect(() => recordSplitReaction(addExposure(solo, "dish-bulalo", NOW), "a", NOW)).toThrow(/Together Mode/);
  });
});

describe("joint ranking (ETD §8.10)", () => {
  it("Joint = 0.65 × mean + 0.35 × min, so a dish both want beats one only one person wants", () => {
    let s = shared(together(), "dish-chicken-pho", "yes");
    s = split(s, "dish-pork-tonkatsu", "a");
    const inputs = scoringInputs(s, deps(POLICY));
    const both = jointScore(catalog.byId.get("dish-chicken-pho")!, inputs);
    const onlyA = jointScore(catalog.byId.get("dish-pork-tonkatsu")!, inputs);
    for (const j of [both, onlyA]) {
      const { a, b } = j.perParticipant;
      expect(j.utility).toBeCloseTo(JOINT_V0.meanWeight * ((a + b) / 2) + JOINT_V0.minWeight * Math.min(a, b), 12);
    }
    expect(onlyA.perParticipant.a).toBeGreaterThan(onlyA.perParticipant.b);
    expect(both.utility).toBeGreaterThan(onlyA.utility);
  });

  it("a shared 'not for us' removes the dish; a one-sided 'no' does not", () => {
    let s = shared(together(), "dish-bulalo", "no");
    s = split(s, "dish-chicken-pho", "b");
    s = shared(s, "dish-beef-pho", "yes");
    const ids = recommend(s, deps(POLICY)).items.map((i) => i.dishId);
    expect(ids).not.toContain("dish-bulalo");
    const inputs = scoringInputs(s, deps(POLICY));
    expect(Number.isFinite(jointScore(catalog.byId.get("dish-chicken-pho")!, inputs).utility)).toBe(true);
  });

  it("explains shared likes as 'you both said yes' and one-sided likes by name — never 'both liked' from a shared vote", () => {
    let s = shared(together(), "dish-chicken-pho", "yes");
    s = shared(s, "dish-tom-yum-goong", "yes");
    s = split(s, "dish-pork-tonkatsu", "a");
    const run = recommend(s, deps(POLICY));
    const codes = run.items.flatMap((i) => i.reasonCodes);
    expect(codes).not.toContain("BOTH_PARTICIPANTS_LIKED");
    const texts = run.items.flatMap((i) => explainItem(i, catalog, "reactions", names).map((e) => e.text));
    expect(texts.some((t) => /you both said yes/.test(t))).toBe(true);
    for (const i of run.items) {
      const top = i.evidence.likedSimilar[0];
      if (top?.by) expect(explainItem(i, catalog, "reactions", names).map((e) => e.text).join(" ")).toMatch(top.by === "a" ? /Rave/ : /Sam/);
    }
  });
});

describe("privacy and safety (R-022, R-023)", () => {
  it("uses no personal history: meals, taste fatigue and stored preferences change nothing", () => {
    let s = shared(together(), "dish-chicken-pho", "yes");
    s = split(s, "dish-pork-tonkatsu", "b");
    const withHistory = { ...deps(POLICY), user: { stableAttributeWeights: { "flavor:spicy": 1 }, confirmedMeals: [meal("m1", "dish-chicken-pho", 3), meal("m2", "dish-beef-pho", 20)], noveltyPreference: 0.9, varietySeeking: 1.5 } };
    const a = recommend(s, withHistory);
    const b = recommend(s, deps(POLICY));
    expect(a.items.map((i) => [i.dishId, i.appealScore])).toEqual(b.items.map((i) => [i.dishId, i.appealScore]));
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(a.items.flatMap((i) => i.reasonCodes)).not.toContain("RECENT_FOOD_VARIETY");
    expect(selectNextCard(s, withHistory)).toEqual(selectNextCard(s, deps(POLICY)));
  });

  it("both people's restrictions exclude confirmed-conflict dishes before ranking; possible conflicts are flagged", () => {
    let s = together(["pork", "shellfish"]);
    for (let i = 0; i < 12; i++) {
      const next = selectNextCard(s, deps(POLICY));
      if (!next) break;
      s = recordReaction(addExposure(s, next.dishId, NOW), "yes", NOW);
    }
    const run = recommend(s, deps(POLICY));
    for (const item of run.items) {
      const claims = catalog.byId.get(item.dishId)!.ingredients;
      expect(claims.some((c) => (c.key === "pork" || c.key === "shellfish") && c.presence === "confirmed_present")).toBe(false);
      if (claims.some((c) => c.key === "pork" || c.key === "shellfish")) expect(item.safety.status).toBe("possible_conflict");
    }
    expect(readiness(s, deps(POLICY)).exhausted).toBe(false);
  });
});

describe("what you two ate recently (session-only taste fatigue)", () => {
  const fried = (who: TogetherMeal["who"]) => [ate("m1", "dish-lechon-kawali", 14, who), ate("m2", "dish-korean-fried-chicken", 20, who), ate("m3", "dish-pork-tonkatsu", 30, who)];

  it("a person's meals lower only THEIR side; meals you both had lower both", () => {
    const dish = catalog.byId.get("dish-chicken-karaage")!;
    const base = jointScore(dish, scoringInputs(together(), deps(POLICY)), { a: { ...EMPTY_USER }, b: { ...EMPTY_USER } });
    const sOnlyB = together([], fried("b"));
    const onlyB = jointScore(dish, scoringInputs(sOnlyB, deps(POLICY)), participantUsers(sOnlyB));
    expect(onlyB.perParticipant.a).toBeCloseTo(base.perParticipant.a, 12);
    expect(onlyB.perParticipant.b).toBeLessThan(base.perParticipant.b);
    const sBoth = together([], fried("both"));
    const both = jointScore(dish, scoringInputs(sBoth, deps(POLICY)), participantUsers(sBoth));
    expect(both.perParticipant.a).toBeLessThan(base.perParticipant.a);
    expect(both.utility).toBeLessThan(onlyB.utility);
  });

  it("dishes either of you just ate go to the back of the card queue", () => {
    let s = together([], [ate("m1", "dish-chicken-pho", 3, "a"), ate("m2", "dish-bulalo", 10, "b")]);
    const shown: string[] = [];
    for (let i = 0; i < 25; i++) {
      const next = selectNextCard(s, deps(POLICY));
      if (!next) break;
      shown.push(next.dishId);
      s = recordReaction(addExposure(s, next.dishId, NOW), "no", NOW);
    }
    expect(shown).not.toContain("dish-chicken-pho");
    expect(shown).not.toContain("dish-bulalo");
  });

  it("picks steer away from what you both just had and can say so", () => {
    let s = together([], fried("both"));
    s = shared(s, "dish-chicken-pho", "yes");
    s = shared(s, "dish-pork-sisig", "yes");
    const run = recommend(s, deps(POLICY));
    expect(run.items.map((i) => i.dishId)).not.toContain("dish-lechon-kawali");
    const texts = run.items.flatMap((i) => explainItem(i, catalog, "reactions", names).map((e) => e.text)).join(" ");
    if (run.items.some((i) => i.reasonCodes.includes("RECENT_FOOD_VARIETY"))) expect(texts).toMatch(/you've had recently/);
  });

  it("solo sessions never carry Together meals", () => {
    const solo = createSession({ sessionId: "s", seed: 1, policyId: POLICY, catalogVersion: catalog.catalogVersion, constraints: DEFAULT_CONSTRAINTS, now: NOW, initialBudget: 10, togetherMeals: fried("both") });
    expect(solo.togetherMeals).toEqual([]);
  });
});
