/** "In the mood for…" session focus — narrows tonight's dishes; never a dietary rule. */
import { describe, expect, it } from "vitest";
import { buildCandidates, DEFAULT_CONSTRAINTS } from "./eligibility.ts";
import { CRAVINGS, inFocus } from "./mood.ts";
import { recommend } from "./recommend.ts";
import { selectNextCard } from "./selection.ts";
import { addExposure, recordReaction } from "./session.ts";
import { catalog, deps, newSession, NOW } from "./test-helpers.ts";

const dish = (id: string) => catalog.byId.get(id)!;

describe("inFocus", () => {
  it("alternatives within a group, all groups together", () => {
    const f = { cuisines: ["japanese", "korean"], cravings: ["noodles" as const] };
    expect(inFocus(dish("dish-tonkotsu-ramen"), f)).toBe(true);
    expect(inFocus(dish("dish-japchae"), f)).toBe(true);
    expect(inFocus(dish("dish-chicken-karaage"), f)).toBe(false); // Japanese, not noodles
    expect(inFocus(dish("dish-chicken-pho"), f)).toBe(false); // noodles, not Japanese/Korean
    expect(inFocus(dish("dish-chicken-pho"), { cuisines: [], cravings: [] })).toBe(true);
  });

  it("every craving matches a sensible set of dishes", () => {
    for (const [key, c] of Object.entries(CRAVINGS)) {
      const n = catalog.dishes.filter((d) => c.test(d)).length;
      expect(n, key).toBeGreaterThanOrEqual(8);
      expect(n, key).toBeLessThan(catalog.dishes.length / 2);
    }
    expect(CRAVINGS.soup.test(dish("dish-bulalo"))).toBe(true);
    expect(CRAVINGS.handheld.test(dish("dish-doner-kebab"))).toBe(true);
    expect(CRAVINGS.seafood.test(dish("dish-shrimp-sinigang"))).toBe(true);
  });
});

describe("focus in a session", () => {
  const focused = (avoid: ("pork" | "shellfish")[] = []) =>
    newSession("adaptive-v2", 3, { ...DEFAULT_CONSTRAINTS, avoidedIngredients: avoid, focus: { cuisines: ["filipino"], cravings: ["soup"] } });

  it("only shows and recommends dishes in focus", () => {
    let s = focused();
    for (let i = 0; i < 6; i++) {
      const next = selectNextCard(s, deps("adaptive-v2"));
      if (!next) break;
      expect(inFocus(dish(next.dishId), s.constraints.focus)).toBe(true);
      s = recordReaction(addExposure(s, next.dishId, NOW), i % 2 ? "no" : "yes", NOW);
    }
    for (const item of recommend(s, deps("adaptive-v2")).items) expect(inFocus(dish(item.dishId), s.constraints.focus)).toBe(true);
  });

  it("counts mood-filtered dishes separately from dietary exclusions (no false 'hidden by restrictions')", () => {
    const c = buildCandidates(catalog, focused().constraints);
    expect(c.excluded).toHaveLength(0);
    expect(c.outOfFocus).toBeGreaterThan(150);
    const r = recommend(focused(), deps("adaptive-v2"));
    expect(r.excludedByConstraints).toBe(0);
    expect(r.runReasonCodes).not.toContain("HARD_CONSTRAINT_EXCLUDED");
  });

  it("dietary exclusions still apply inside the focus", () => {
    const c = buildCandidates(catalog, focused(["pork", "shellfish"]).constraints);
    expect(c.eligible.map((d) => d.id)).not.toContain("dish-pork-sinigang");
    expect(c.eligible.map((d) => d.id)).not.toContain("dish-shrimp-sinigang");
    expect(c.excluded.length).toBeGreaterThan(0);
  });
});
