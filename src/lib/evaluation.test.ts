import { describe, expect, it } from "vitest";
import { addExposure, recommend, recordReaction, undoLastReaction } from "@/engine";
import { deps, newSession, NOW } from "@/engine/test-helpers";
import { exposureRecords, rotatePolicy, runRecord, summarize, toCsv } from "./evaluation";
import type { EvalSessionRecord } from "./local-store";

function record(policyId: string, extra: Partial<EvalSessionRecord> = {}): EvalSessionRecord {
  let s = newSession(policyId);
  s = recordReaction(addExposure(s, "dish-chicken-pho", NOW), "yes", NOW);
  s = recordReaction(addExposure(s, "dish-pork-tonkatsu", NOW), "no", NOW);
  const run = recommend(s, deps(policyId));
  return {
    schemaVersion: 1,
    sessionId: `${policyId}-1`,
    policyId,
    assignment: "rotation",
    catalogVersion: s.catalogVersion,
    seed: s.seed,
    startedAt: NOW,
    updatedAt: NOW,
    hardConstraintsActive: false,
    excludedByConstraints: 0,
    exposures: exposureRecords(s, {}),
    recommendationRuns: [runRecord(run, NOW, "user_request")],
    events: [],
    ...extra,
  };
}

describe("ENG-018 evaluation records", () => {
  it("records accepted, rejected and undone reactions", () => {
    let s = newSession();
    s = recordReaction(addExposure(s, "dish-chicken-pho", NOW), "yes", NOW);
    s = addExposure(s, "dish-pork-tonkatsu", NOW);
    s = undoLastReaction(s, NOW);
    s = recordReaction(s, "no", NOW);
    const ex = exposureRecords(s, { "s1:x1": { selectionReason: "cold_start_variety", q: null } });
    expect(ex[0]).toMatchObject({ dishId: "dish-chicken-pho", reaction: "no", undoneReactions: ["yes"], selectionReason: "cold_start_variety" });
    expect(ex[1]).toMatchObject({ dishId: "dish-pork-tonkatsu", reaction: null, withdrawn: true });
  });

  it("policy A vs B runs are distinguishable and comparable (AT-032)", () => {
    const sum = summarize([record("baseline-fixed-v0"), record("adaptive-v1")]);
    const base = sum.find((x) => x.policyId === "baseline-fixed-v0")!;
    const adapt = sum.find((x) => x.policyId === "adaptive-v1")!;
    expect(base.sessions).toBe(1);
    expect(adapt.sessions).toBe(1);
    expect(base.yesRate).toBe(0.5);
    expect(sum.find((x) => x.policyId === "adaptive-exposure-v1")!.sessions).toBe(0);
  });

  it("missing ratings are absent, not negative", () => {
    const rec = record("adaptive-v1", {
      events: [
        { type: "dish_selected", at: NOW, dishId: "dish-chicken-pho", rank: 1, runIndex: 0 },
        { type: "meal_consumption_confirmed", at: NOW, mealId: "m1", dishId: "dish-chicken-pho", matchesSelection: true, unrecognized: false },
      ],
    });
    const s = summarize([rec]).find((x) => x.policyId === "adaptive-v1")!;
    expect(s.mealsConfirmed).toBe(1);
    expect(s.ratings).toBe(0);
    expect(s.meanRating).toBeNull();
  });

  it("CSV has one row per exposure and escapes safely", () => {
    const csv = toCsv([record("adaptive-v1")]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("session_id,policy_id");
    expect(lines).toHaveLength(3);
    expect(csv).not.toMatch(/shellfish|peanut|allerg/i);
  });

  it("rotation spreads sessions across all three policies", () => {
    expect([0, 1, 2, 3].map(rotatePolicy)).toEqual(["baseline-fixed-v0", "adaptive-v1", "adaptive-exposure-v1", "baseline-fixed-v0"]);
  });
});
