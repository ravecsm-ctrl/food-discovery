/**
 * Together Mode on one phone (PRRD J-03, R-002, R-011; ETD §8.10).
 *
 * - Each card gets one shared reaction; a disagreement records who wanted it (two attributed
 *   reactions). A shared Yes is a joint signal, never two separately observed individual Yes.
 * - Each person's desirability Uj uses the shared reactions plus that person's attributed ones.
 *   Joint(d) = 0.65 × mean(Ua, Ub) + 0.35 × min(Ua, Ub): appeal, protected against a dish one person
 *   clearly doesn't want.
 * - Privacy (R-022): Together Mode uses NO personal history — no meal history, taste fatigue or stored
 *   preferences of either person — because both people see the same screen. Hard dietary exclusions
 *   (both people's) still apply before ranking.
 */
import { EMPTY_USER, scoreDish, type ScoreBreakdown, type ScoringInputs } from "./scoring.ts";
import type { DiscoverySession } from "./session.ts";
import type { Dish } from "./types.ts";
import type { EngineDeps } from "./selection.ts";

/** Versioned joint-ranking coefficients (ETD §8.10 P0 default). Change by adding a new id. */
export const JOINT_V0 = { id: "joint-v0", meanWeight: 0.65, minWeight: 0.35 } as const;

/** The engine inputs a session may use: Together Mode never sees personal history. */
export function depsForSession(session: DiscoverySession, deps: EngineDeps): EngineDeps {
  return session.mode === "together" ? { ...deps, user: EMPTY_USER } : deps;
}

export interface JointScore extends ScoreBreakdown {
  /** Each person's desirability on the same scale (internal; never shown as a percentage). */
  perParticipant: { a: number; b: number };
}

export function jointScore(dish: Dish, inputs: ScoringInputs): JointScore {
  const shared = inputs.reactions.filter((r) => !r.participant);
  const forA = scoreDish(dish, { ...inputs, reactions: [...shared, ...inputs.reactions.filter((r) => r.participant === "a")] });
  const forB = scoreDish(dish, { ...inputs, reactions: [...shared, ...inputs.reactions.filter((r) => r.participant === "b")] });
  const utility = JOINT_V0.meanWeight * ((forA.utility + forB.utility) / 2) + JOINT_V0.minWeight * Math.min(forA.utility, forB.utility);

  // Shared likes first (both of you), then each person's own likes; one entry per liked dish.
  const likes = new Map<string, ScoreBreakdown["supportingLikes"][number]>();
  for (const l of [...forA.supportingLikes, ...forB.supportingLikes]) {
    const prev = likes.get(l.dishId);
    if (!prev || (prev.by && !l.by)) likes.set(l.dishId, l);
  }
  const supportingLikes = [...likes.values()].sort(
    (x, y) => Number(!!x.by) - Number(!!y.by) || y.similarity - x.similarity || x.dishId.localeCompare(y.dishId),
  );

  return {
    ...forA,
    current: (forA.current + forB.current) / 2,
    currentEvidence: Math.max(forA.currentEvidence, forB.currentEvidence),
    utility,
    supportingLikes,
    perParticipant: { a: forA.utility, b: forB.utility },
  };
}
