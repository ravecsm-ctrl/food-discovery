import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  addExposure,
  baselineSequence,
  buildCandidates,
  canUndo,
  createRng,
  currentAppetite,
  currentExposure,
  dishSimilarity,
  explainItem,
  exposureAdjustment,
  getPolicy,
  recommend,
  readiness,
  recordReaction,
  scoreDish,
  selectNextCard,
  undoLastReaction,
  type DiscoverySession,
  type UserModel,
} from "./index.ts";
import { scoringInputs } from "./selection.ts";
import { catalog, deps, meal, newSession, NOW, reactTo, runPolicy } from "./test-helpers.ts";

const PHO = "dish-chicken-pho";
const TINOLA = "dish-chicken-tinola";
const CARBONARA = "dish-spaghetti-carbonara";
const SINIGANG_SHRIMP = "dish-shrimp-sinigang";
const W = getPolicy("adaptive-v1").similarityKindWeights;

const dish = (id: string) => catalog.byId.get(id)!;
const util = (s: DiscoverySession, id: string, d = deps()) => scoreDish(dish(id), scoringInputs(s, d)).utility;
const current = (s: DiscoverySession, id: string, d = deps()) => currentAppetite(id, scoringInputs(s, d)).value;

describe("ENG-008 similarity", () => {
  it("is symmetric, bounded, and 1 for identity", () => {
    const rng = createRng(7);
    for (let i = 0; i < 200; i++) {
      const a = catalog.dishes[Math.floor(rng() * catalog.dishes.length)]!.id;
      const b = catalog.dishes[Math.floor(rng() * catalog.dishes.length)]!.id;
      const s = dishSimilarity(catalog, a, b, W);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(s).toBeCloseTo(dishSimilarity(catalog, b, a, W), 12);
    }
    expect(dishSimilarity(catalog, PHO, PHO, W)).toBe(1);
  });

  it("ranks culinary neighbours above unrelated dishes (validated numerical fixtures)", () => {
    expect(dishSimilarity(catalog, PHO, TINOLA, W)).toBeGreaterThan(0.5);
    expect(dishSimilarity(catalog, PHO, "dish-sweet-sour-pork", W)).toBeLessThan(0.15);
    expect(dishSimilarity(catalog, "dish-pork-tonkatsu", "dish-lechon-kawali", W)).toBeGreaterThan(0.8);
    expect(dishSimilarity(catalog, "dish-margherita-pizza", "dish-pepperoni-pizza", W)).toBeGreaterThan(0.8);
  });
});

describe("ALG-001 / AT-002 cold start, no history", () => {
  it("first cards are diverse, recognizable, and carry no fabricated personalization", () => {
    const d = deps();
    const { shown } = runPolicy(newSession(), d, 3, () => "yes");
    const structures = shown.map((id) => Object.keys(dish(id).attributes).find((k) => k.startsWith("structure:")));
    expect(new Set(structures).size).toBe(3);
    for (const id of shown) expect(dish(id).recognizability).toBeGreaterThanOrEqual(0.8);
    for (const id of shown) {
      const s = scoreDish(dish(id), scoringInputs(newSession(), d));
      expect(s.stable).toBe(0);
      expect(s.novelty).toBe(0);
      expect(s.exposureAdjustment).toBe(0);
    }
  });

  it("no reactions → no shortlist (no fabricated match)", () => {
    const run = recommend(newSession(), deps());
    expect(run.noMatch).toBe(true);
    expect(run.items).toHaveLength(0);
  });
});

describe("ENG-010 current-session learning (ALG-002/003, R-008)", () => {
  it("ALG-002: Yes on Chicken Pho raises similar brothy dishes", () => {
    const base = newSession();
    const liked = reactTo(base, PHO, "yes");
    expect(current(liked, TINOLA)).toBeGreaterThan(0.3);
    expect(util(liked, TINOLA)).toBeGreaterThan(util(base, TINOLA));
    expect(current(liked, "dish-sweet-sour-pork")).toBe(0);
  });

  it("ALG-003: No on Chicken Pho lowers sufficiently similar dishes only", () => {
    const base = newSession();
    const rejected = reactTo(base, PHO, "no");
    expect(util(rejected, TINOLA)).toBeLessThan(util(base, TINOLA));
    expect(util(rejected, "dish-sweet-sour-pork")).toBe(util(base, "dish-sweet-sour-pork"));
  });

  it("scores stay within [-1, 1] under random reaction histories (property)", () => {
    const rng = createRng(99);
    for (let trial = 0; trial < 20; trial++) {
      let s = newSession("adaptive-v0", trial);
      const ids = [...catalog.dishes].sort(() => rng() - 0.5).slice(0, 12).map((x) => x.id);
      for (const id of ids) s = reactTo(s, id, rng() > 0.5 ? "yes" : "no", rng() > 0.8 ? "explicit" : "ordinary");
      for (const dd of catalog.dishes) {
        const sc = scoreDish(dd, scoringInputs(s, deps()));
        for (const v of [sc.current, sc.stable, sc.softContext, sc.novelty, sc.utility]) {
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("documents ETD-literal 'global' normalization dilution (deviation D-03)", () => {
    let s = reactTo(newSession(), PHO, "yes");
    for (const id of ["dish-sweet-sour-pork", "dish-margherita-pizza", "dish-beef-bulgogi", "dish-tteokbokki", "dish-pork-tonkatsu"]) s = reactTo(s, id, "no");
    const literal = deps("adaptive-v1", undefined, { currentAppetite: { normalization: "global", similarityFloor: 0, kernelExponent: 1, priorStrength: 0 } });
    expect(current(s, PHO, literal)).toBeLessThan(0.2);
    expect(current(s, PHO)).toBeGreaterThan(0.5);
  });
});

describe("ALG-004 / AT-006 / ENG-017 undo", () => {
  it("undo restores ranking exactly and re-presents the card", () => {
    const d = deps();
    let s = runPolicy(newSession(), d, 4, (_id, i) => (i % 2 ? "yes" : "no")).session;
    const before = recommend(s, d);
    const nextBefore = selectNextCard(s, d)!;
    s = addExposure(s, nextBefore.dishId, NOW);
    const reactedOn = currentExposure(s)!;
    s = recordReaction(s, "no", NOW);
    s = addExposure(s, selectNextCard(s, d)!.dishId, NOW);
    expect(recommend(s, d).inputDigest).not.toBe(before.inputDigest);

    s = undoLastReaction(s, NOW);
    expect(currentExposure(s)!.exposureId).toBe(reactedOn.exposureId);
    const after = recommend(s, d);
    expect(after.inputDigest).toBe(before.inputDigest);
    expect(after.items.map((x) => x.dishId)).toEqual(before.items.map((x) => x.dishId));
    // invalidated evidence is retained for evaluation but inactive
    expect(s.reactions.filter((r) => !r.active)).toHaveLength(1);
    expect(s.exposures.filter((e) => e.withdrawn)).toHaveLength(1);
  });

  it("re-reacting identically after undo yields the same next card", () => {
    const d = deps();
    let s = runPolicy(newSession(), d, 4, () => "yes").session;
    s = addExposure(s, selectNextCard(s, d)!.dishId, NOW);
    s = recordReaction(s, "yes", NOW);
    const nextA = selectNextCard(s, d)!.dishId;
    s = addExposure(s, nextA, NOW);
    s = undoLastReaction(s, NOW);
    s = recordReaction(s, "yes", NOW);
    expect(selectNextCard(s, d)!.dishId).toBe(nextA);
  });

  it("multiple undos walk back and stop at the start", () => {
    let s = runPolicy(newSession(), deps(), 2, () => "yes").session;
    s = undoLastReaction(undoLastReaction(s, NOW), NOW);
    expect(canUndo(s)).toBe(false);
    expect(undoLastReaction(s, NOW)).toBe(s);
  });
});

describe("ALG-005 / AT-005 temporary rejection of a stable favorite", () => {
  it("a No lowers current appeal but leaves stable preference untouched", () => {
    const user: UserModel = { stableAttributeWeights: { "structure:pasta": 0.9 }, confirmedMeals: [], noveltyPreference: 0.5 };
    const d = deps("adaptive-v0", user);
    const base = newSession();
    const rejected = reactTo(base, CARBONARA, "no");
    const before = scoreDish(dish(CARBONARA), scoringInputs(base, d));
    const after = scoreDish(dish(CARBONARA), scoringInputs(rejected, d));
    expect(after.stable).toBe(before.stable);
    expect(after.stable).toBeGreaterThan(0.5);
    expect(after.current).toBeLessThan(0);
    expect(user.stableAttributeWeights).toEqual({ "structure:pasta": 0.9 });
    // the rejected dish is not recommended this session ("not tonight")
    expect(recommend(rejected, d).items.map((i) => i.dishId)).not.toContain(CARBONARA);
    // other pasta dishes remain possible
    expect(recommend(rejected, d).items.some((i) => dish(i.dishId).attributes["structure:pasta"])).toBe(true);
  });
});

describe("ENG-011 exposure (ALG-006/007/008, R-012)", () => {
  const exp = (meals: ReturnType<typeof meal>[], id: string) =>
    exposureAdjustment(id, scoringInputs(newSession(), deps("adaptive-exposure-v1", { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 })));

  it("ALG-006: recent fried meals lower similar fried dishes, within the cap", () => {
    const meals = [meal("m1", "dish-lechon-kawali", 10), meal("m2", "dish-korean-fried-chicken", 30), meal("m3", "dish-chicken-adobo", 50), meal("m4", "dish-bulalo", 60)];
    const fried = exp(meals, "dish-pork-tonkatsu");
    const soup = exp(meals, "dish-chicken-pho");
    expect(fried.adjustment).toBeLessThan(soup.adjustment);
    expect(fried.adjustment).toBeGreaterThanOrEqual(-0.12);
  });

  it("ALG-007: no confirmed meals → zero adjustment", () => {
    expect(exp([], "dish-pork-tonkatsu")).toEqual({ exposure: 0, adjustment: 0 });
  });

  it("is disabled in non-exposure policies", () => {
    const meals = [meal("m1", "dish-pork-tonkatsu", 1)];
    const r = exposureAdjustment("dish-pork-tonkatsu", scoringInputs(newSession(), deps("adaptive-v0", { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 })));
    expect(r.adjustment).toBe(0);
  });

  it("ALG-008: a corrected meal removes the old contribution and applies the new one", () => {
    const wrong = [meal("m1", "dish-pork-tonkatsu", 5), meal("m2", "dish-bulalo", 40)];
    const corrected = [meal("m1", "dish-chicken-pho", 5), meal("m2", "dish-bulalo", 40)];
    expect(exp(corrected, "dish-lechon-kawali").exposure).toBeLessThan(exp(wrong, "dish-lechon-kawali").exposure);
    expect(exp(corrected, "dish-chicken-tinola").exposure).toBeGreaterThan(exp(wrong, "dish-chicken-tinola").exposure);
  });

  it("duplicate meal ids are not double-counted; meals older than 7 days are ignored", () => {
    const one = exp([meal("m1", "dish-pork-tonkatsu", 5)], "dish-lechon-kawali");
    const dup = exp([meal("m1", "dish-pork-tonkatsu", 5), meal("m1", "dish-pork-tonkatsu", 5)], "dish-lechon-kawali");
    expect(dup).toEqual(one);
    expect(exp([meal("old", "dish-pork-tonkatsu", 24 * 8)], "dish-lechon-kawali").adjustment).toBe(0);
  });

  it("recent meals change ranking order in the exposure-aware policy", () => {
    const meals = ["dish-lechon-kawali", "dish-pork-tonkatsu", "dish-korean-fried-chicken", "dish-chicken-karaage"].map((id, i) => meal(`m${i}`, id, 6 + i * 12));
    let s = newSession("adaptive-exposure-v1");
    s = reactTo(s, "dish-sweet-sour-pork", "yes");
    s = reactTo(s, "dish-chicken-pho", "yes");
    const withMeals = deps("adaptive-exposure-v1", { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 });
    const noMeals = deps("adaptive-exposure-v1");
    const gap = (dd: ReturnType<typeof deps>) => util(s, "dish-chicken-pho", dd) - util(s, "dish-sweet-sour-pork", dd);
    expect(gap(withMeals)).toBeGreaterThan(gap(noMeals));
  });
});

describe("ENG-009 hard constraints (ALG-009/010, AT-009/010, R-009, R-023)", () => {
  it("ALG-009: shellfish avoidance excludes Shrimp Sinigang even when it would rank first", () => {
    const user: UserModel = { stableAttributeWeights: { "ingredient:shrimp": 1, "flavor:sour": 1 }, confirmedMeals: [], noveltyPreference: 0.5 };
    const d = deps("adaptive-v0", user);
    let s = newSession("adaptive-v0", 42, { avoidedIngredients: ["shellfish"] });
    s = reactTo(s, "dish-pork-sinigang", "yes");
    const run = recommend(s, d);
    expect(run.items.map((i) => i.dishId)).not.toContain(SINIGANG_SHRIMP);
    expect(run.runReasonCodes).toContain("HARD_CONSTRAINT_EXCLUDED");
    const { shown } = runPolicy(newSession("adaptive-v0", 1, { avoidedIngredients: ["shellfish"] }), d, 40, () => "yes");
    expect(shown).not.toContain(SINIGANG_SHRIMP);
    expect(shown).not.toContain("dish-shrimp-tempura");
    expect(() => addExposure(newSession(), SINIGANG_SHRIMP, NOW)).not.toThrow(); // only constraints exclude, not the session
  });

  it("hard exclusions never re-enter under any seed or policy (property)", () => {
    for (const policyId of ["baseline-fixed-v0", "adaptive-v0", "adaptive-v1", "adaptive-exposure-v1"]) {
      for (let seed = 0; seed < 5; seed++) {
        const { shown, session } = runPolicy(newSession(policyId, seed, { avoidedIngredients: ["pork", "peanut"] }), deps(policyId), 60, (_id, i) => (i % 3 ? "yes" : "no"));
        for (const id of shown) {
          const conflicts = dish(id).ingredients.filter((c) => ["pork", "peanut"].includes(c.key) && c.presence === "confirmed_present");
          expect(conflicts).toEqual([]);
        }
        for (const item of recommend(session, deps(policyId)).items) expect(["dish-pork-adobo", "dish-kare-kare"]).not.toContain(item.dishId);
      }
    }
  });

  it("ALG-010: unknown or possible ingredients never become a safety claim", () => {
    const { byId } = buildCandidates(catalog, { acquisition: "any", acquisitionIsHard: false, maxBudgetPhp: null, avoidedIngredients: ["shellfish"], softAttributeWeights: {} });
    expect(byId.get("dish-vegetable-curry")!.safety.status).toBe("unverified"); // no ingredient data at all
    expect(byId.get("dish-pad-thai")!.eligible).toBe(false);
    expect(byId.get("dish-yangzhou-fried-rice")!.safety).toEqual({ status: "possible_conflict", possibleConflicts: ["shellfish"] });
    for (const r of byId.values()) expect(r.safety.status).not.toBe("verified_safe" as never);
  });

  it("ALG-016: delivery-only with no availability data is search-only, never verified", () => {
    let s = newSession("adaptive-v0", 3, { acquisition: "delivery", acquisitionIsHard: true, maxBudgetPhp: 300 });
    s = reactTo(s, PHO, "yes");
    const run = recommend(s, deps());
    expect(run.items.length).toBeGreaterThan(0);
    for (const i of run.items) {
      expect(i.fulfillmentStatus).toBe("search_only");
      expect(i.reasonCodes).toContain("FULFILLMENT_UNVERIFIED");
    }
    expect(buildCandidates(catalog, s.constraints).byId.get(PHO)!.budgetVerified).toBe(false);
  });
});

describe("ENG-012/013 card policies (ALG-011, ALG-018, R-004, R-014)", () => {
  it("ALG-011: identical seed and inputs → identical order and shortlist", () => {
    for (const policyId of ["baseline-fixed-v0", "adaptive-v0", "adaptive-v1", "adaptive-exposure-v1"]) {
      const react = (id: string) => (dish(id).attributes["texture:brothy"] ? "yes" : "no");
      const a = runPolicy(newSession(policyId, 123), deps(policyId), 10, react);
      const b = runPolicy(newSession(policyId, 123), deps(policyId), 10, react);
      expect(a.shown).toEqual(b.shown);
      expect(recommend(a.session, deps(policyId))).toEqual(recommend(b.session, deps(policyId)));
    }
  });

  it("baseline order is fixed regardless of reactions", () => {
    const d = deps("baseline-fixed-v0");
    const yes = runPolicy(newSession("baseline-fixed-v0"), d, 10, () => "yes").shown;
    const no = runPolicy(newSession("baseline-fixed-v0"), d, 10, () => "no").shown;
    expect(yes).toEqual(no);
    expect(yes).toEqual(baselineSequence(buildCandidates(catalog, newSession().constraints).eligible, d, 42).slice(0, 10));
  });

  it("adaptive order responds to reactions", () => {
    const d = deps("adaptive-v1");
    const brothy = runPolicy(newSession(), d, 8, (id) => (dish(id).attributes["texture:brothy"] ? "yes" : "no")).shown;
    const crispy = runPolicy(newSession(), d, 8, (id) => (dish(id).attributes["texture:crispy"] ? "yes" : "no")).shown;
    expect(brothy.slice(0, 3)).toEqual(crispy.slice(0, 3)); // cold start identical
    expect(brothy).not.toEqual(crispy);
  });

  it("adaptive learns: brothy-lover sees more brothy cards than baseline after cold start", () => {
    const likesBrothy = (id: string) => ((dish(id).attributes["texture:brothy"] ?? 0) >= 0.8 ? "yes" : "no");
    const count = (shown: string[]) => shown.slice(3).filter((id) => likesBrothy(id) === "yes").length;
    let adaptive = 0;
    let baseline = 0;
    for (let seed = 0; seed < 10; seed++) {
      adaptive += count(runPolicy(newSession("adaptive-v1", seed), deps("adaptive-v1"), 10, likesBrothy).shown);
      baseline += count(runPolicy(newSession("baseline-fixed-v0", seed), deps("baseline-fixed-v0"), 10, likesBrothy).shown);
    }
    expect(adaptive).toBeGreaterThan(baseline);
  });

  it("D-05: normalized next-card terms (v1) adapt more than the ETD-literal terms (v0)", () => {
    const likesBrothy = (id: string) => ((dish(id).attributes["texture:brothy"] ?? 0) >= 0.8 ? "yes" : "no");
    const yesAfterColdStart = (policyId: string) => {
      let n = 0;
      for (let seed = 0; seed < 10; seed++) n += runPolicy(newSession(policyId, seed), deps(policyId), 10, likesBrothy).shown.slice(3).filter((id) => likesBrothy(id) === "yes").length;
      return n;
    };
    expect(yesAfterColdStart("adaptive-v1")).toBeGreaterThan(yesAfterColdStart("adaptive-v0"));
  });

  it("D-05: evidence-weighted information is zero for dishes unrelated to any reaction", () => {
    const s = reactTo(newSession(), PHO, "yes");
    const unrelated = currentAppetite("dish-sweet-sour-pork", scoringInputs(s, deps()));
    expect(unrelated.evidence).toBe(0);
    expect(currentAppetite(TINOLA, scoringInputs(s, deps())).evidence).toBeGreaterThan(0);
  });

  it("never repeats a dish within a session and exhausts cleanly", () => {
    const { shown, session } = runPolicy(newSession(), deps(), 100, () => "no");
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.length).toBe(catalog.dishes.length);
    expect(selectNextCard(session, deps())).toBeNull();
    expect(readiness(session, deps()).exhausted).toBe(true);
  });

  it("ALG-018: baseline and adaptive draw from the same eligible set", () => {
    const constraints = { avoidedIngredients: ["beef" as const] };
    const a = runPolicy(newSession("adaptive-v1", 5, constraints), deps("adaptive-v1"), 100, () => "yes").shown;
    const b = runPolicy(newSession("baseline-fixed-v0", 5, constraints), deps("baseline-fixed-v0"), 100, () => "yes").shown;
    expect(new Set(a)).toEqual(new Set(b));
  });

  it("changing the seed never changes eligibility", () => {
    const sets = [1, 2, 3].map((seed) => new Set(runPolicy(newSession("adaptive-v0", seed, { avoidedIngredients: ["fish"] }), deps(), 100, () => "no").shown));
    expect(sets[0]).toEqual(sets[1]);
    expect(sets[1]).toEqual(sets[2]);
  });
});

describe("ENG-014 shortlist (ALG-012/013, AT-007/008, R-005, R-010)", () => {
  it("returns at most 3 distinct, non-near-duplicate dishes", () => {
    for (let seed = 0; seed < 10; seed++) {
      const { session } = runPolicy(newSession("adaptive-v0", seed), deps(), 10, () => "yes");
      const run = recommend(session, deps());
      expect(run.items.length).toBeGreaterThanOrEqual(1);
      expect(run.items.length).toBeLessThanOrEqual(3);
      expect(new Set(run.items.map((i) => i.dishId)).size).toBe(run.items.length);
      for (const a of run.items) for (const b of run.items) if (a !== b) expect(dishSimilarity(catalog, a.dishId, b.dishId, W)).toBeLessThan(0.8);
    }
  });

  it("ALG-012: one strong candidate → one recommendation, not three invented matches", () => {
    let s = newSession();
    s = reactTo(s, "dish-mushroom-risotto", "yes");
    for (const id of ["dish-pork-tonkatsu", "dish-chicken-pho", "dish-beef-bulgogi", "dish-tteokbokki", "dish-pad-thai", "dish-margherita-pizza", "dish-kimchi-jjigae", "dish-salmon-nigiri"]) s = reactTo(s, id, "no");
    const run = recommend(s, deps());
    expect(run.items.map((i) => i.dishId)).toEqual(["dish-mushroom-risotto"]);
  });

  it("ALG-013: everything rejected → explicit no-match, further discovery still possible", () => {
    const { session } = runPolicy(newSession(), deps(), 10, () => "no");
    const run = recommend(session, deps());
    expect(run.noMatch).toBe(true);
    expect(run.items).toEqual([]);
    expect(run.kind).toBe("tentative");
    expect(readiness(session, deps()).exhausted).toBe(false);
  });

  it("early (1 card) results are tentative and say so", () => {
    const s = reactTo(newSession(), PHO, "yes");
    const run = recommend(s, deps());
    expect(run.kind).toBe("tentative");
    expect(run.items[0]!.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
    expect(readiness(s, deps()).canRequestResults).toBe(true);
    expect(readiness(s, deps()).promptReady).toBe(false);
  });

  it("readiness prompt appears only after ≥3 cards with a plausible pick; round ends at 10", () => {
    const d = deps();
    const r2 = readiness(runPolicy(newSession(), d, 2, () => "yes").session, d);
    expect(r2.promptReady).toBe(false);
    const r3 = readiness(runPolicy(newSession(), d, 3, () => "yes").session, d);
    expect(r3.promptReady).toBe(true);
    expect(readiness(runPolicy(newSession(), d, 10, () => "yes").session, d).roundComplete).toBe(true);
  });

  it("appeal scores are internal numbers, not percentages", () => {
    const { session } = runPolicy(newSession(), deps(), 5, () => "yes");
    for (const i of recommend(session, deps()).items) {
      expect(i.appealScore).toBeGreaterThanOrEqual(-1);
      expect(i.appealScore).toBeLessThanOrEqual(1);
    }
  });
});

describe("ENG-015 grounded explanations (R-013)", () => {
  it("every explanation is backed by a code and real evidence", () => {
    const s = reactTo(reactTo(reactTo(newSession(), PHO, "yes"), "dish-pork-tonkatsu", "no"), "dish-margherita-pizza", "no");
    const run = recommend(s, deps());
    for (const item of run.items) {
      const texts = explainItem(item, catalog);
      for (const t of texts) expect(item.reasonCodes).toContain(t.code);
      if (item.reasonCodes.includes("CURRENT_SESSION_POSITIVE")) {
        const liked = item.evidence.likedSimilar[0]!;
        const r = s.reactions.find((x) => x.dishId === liked.dishId)!;
        expect(r.value).toBe("yes");
        expect(r.active).toBe(true);
      }
      expect(item.reasonCodes).not.toContain("STABLE_PREFERENCE_MATCH");
      expect(item.reasonCodes).not.toContain("RECENT_FOOD_VARIETY");
    }
  });

  it("no personal-history claims without history", () => {
    const { session } = runPolicy(newSession("adaptive-exposure-v1"), deps("adaptive-exposure-v1"), 6, () => "yes");
    for (const item of recommend(session, deps("adaptive-exposure-v1")).items) {
      expect(item.reasonCodes).not.toContain("RECENT_FOOD_VARIETY");
      expect(item.reasonCodes).not.toContain("NOVELTY_EXPLORATION");
    }
  });

  it("variety reason appears only when recent confirmed meals exist and the dish differs", () => {
    const meals = ["dish-lechon-kawali", "dish-pork-tonkatsu", "dish-korean-fried-chicken"].map((id, i) => meal(`m${i}`, id, 5 + i));
    const d = deps("adaptive-exposure-v1", { stableAttributeWeights: {}, confirmedMeals: meals, noveltyPreference: 0.5 });
    const s = reactTo(newSession("adaptive-exposure-v1"), PHO, "yes");
    const item = recommend(s, d).items.find((i) => i.dishId === PHO)!;
    expect(item.reasonCodes).toContain("RECENT_FOOD_VARIETY");
  });
});

describe("ALG-017 / AT-029 missing image", () => {
  it("every dish is understandable without an image (name, description, tags)", () => {
    for (const d of catalog.dishes) {
      expect(d.name.length).toBeGreaterThan(1);
      expect(d.description.length).toBeGreaterThan(19);
      expect(d.tags.length).toBeGreaterThan(0);
    }
  });
});

describe("ENG-003 domain boundary", () => {
  it("engine and catalog import no framework, browser, or cloud modules", () => {
    const dirs = ["../engine", "../catalog"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
        const src = readFileSync(join(dir, f), "utf8");
        expect(src, f).not.toMatch(/from\s+["'](react|next|@supabase|openai|@anthropic-ai)/);
        expect(src, f).not.toMatch(/\b(localStorage|window\.|document\.|Math\.random|Date\.now)\b/);
      }
    }
  });
});
