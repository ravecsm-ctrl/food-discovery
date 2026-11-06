/** Shared deterministic fixtures for engine tests (ENG-006, ETD §10). */
import { loadCatalog } from "../catalog/index.ts";
import { DEFAULT_CONSTRAINTS } from "./eligibility.ts";
import { getPolicy, type PolicyConfig } from "./policy.ts";
import { EMPTY_USER } from "./scoring.ts";
import { selectNextCard, type EngineDeps } from "./selection.ts";
import { addExposure, createSession, recordReaction, type DiscoverySession } from "./session.ts";
import type { ConfirmedMeal, ReactionValue, SessionConstraints, UserModel } from "./types.ts";

export const NOW = "2026-11-06T12:00:00.000Z";
export const catalog = loadCatalog();

export function deps(policyId = "adaptive-v0", user: UserModel = EMPTY_USER, overrides?: Partial<PolicyConfig>): EngineDeps {
  const policy = { ...getPolicy(policyId), ...overrides };
  return { catalog, policy, user, now: NOW };
}

export function newSession(policyId = "adaptive-v0", seed = 42, constraints: Partial<SessionConstraints> = {}): DiscoverySession {
  return createSession({
    sessionId: "s1",
    seed,
    policyId,
    catalogVersion: catalog.catalogVersion,
    constraints: { ...DEFAULT_CONSTRAINTS, ...constraints },
    now: NOW,
    initialBudget: 10,
  });
}

/** Show a specific dish and react to it (bypasses the policy — for scoring fixtures). */
export function reactTo(s: DiscoverySession, dishId: string, value: ReactionValue, strength: "ordinary" | "explicit" = "ordinary"): DiscoverySession {
  return recordReaction(addExposure(s, dishId, NOW), value, NOW, strength);
}

/** Run the policy for n cards with a reaction function; returns the session and shown order. */
export function runPolicy(
  s: DiscoverySession,
  d: EngineDeps,
  n: number,
  react: (dishId: string, i: number) => ReactionValue,
): { session: DiscoverySession; shown: string[] } {
  const shown: string[] = [];
  let cur = s;
  for (let i = 0; i < n; i++) {
    const choice = selectNextCard(cur, d);
    if (!choice) break;
    shown.push(choice.dishId);
    cur = recordReaction(addExposure(cur, choice.dishId, NOW), react(choice.dishId, i), NOW);
  }
  return { session: cur, shown };
}

export function meal(id: string, dishId: string | null, hoursAgo: number): ConfirmedMeal {
  return {
    id,
    dishId,
    consumedAt: new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString(),
    confirmed: true,
    source: "synthetic",
  };
}
