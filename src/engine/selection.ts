/**
 * Next-card policies (ENG-012 fixed baseline, ENG-013 adaptive; R-004, R-014, ETD §8.8).
 * Both policies draw from the SAME eligible candidate set (ALG-018).
 */
import { buildCandidates } from "./eligibility.ts";
import type { PolicyConfig } from "./policy.ts";
import { tieBreak } from "./rng.ts";
import { scoreDish, type ScoringInputs } from "./scoring.ts";
import { activeReactions, shownDishIds, type DiscoverySession } from "./session.ts";
import { dishSimilarity } from "./similarity.ts";
import type { Catalog, Dish, UserModel } from "./types.ts";

export interface EngineDeps {
  catalog: Catalog;
  policy: PolicyConfig;
  user: UserModel;
  now: string;
}

export interface CardChoice {
  dishId: string;
  /** How the card was chosen, for evaluation traces. */
  reason: "fixed_sequence" | "cold_start_variety" | "adaptive_utility";
  q: number | null;
}

const ROUND = 1e-9;
const r9 = (x: number) => Math.round(x / ROUND) * ROUND;

export function scoringInputs(session: DiscoverySession, deps: EngineDeps): ScoringInputs {
  return {
    catalog: deps.catalog,
    policy: deps.policy,
    user: deps.user,
    softAttributeWeights: session.constraints.softAttributeWeights,
    reactions: activeReactions(session),
    now: deps.now,
  };
}

function maxSimilarityTo(dishId: string, others: Iterable<string>, deps: EngineDeps): number {
  let m = 0;
  for (const o of others) m = Math.max(m, dishSimilarity(deps.catalog, dishId, o, deps.policy.similarityKindWeights));
  return m;
}

/**
 * Fixed baseline sequence: greedy max-min diversity over eligible dishes, starting from the most
 * recognizable one. Independent of reactions — identical for every session with the same seed/constraints.
 */
export function baselineSequence(eligible: readonly Dish[], deps: EngineDeps, seed: number): string[] {
  const remaining = [...eligible];
  const order: string[] = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestKey: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    remaining.forEach((d, i) => {
      const spread = order.length === 0 ? 1 : 1 - maxSimilarityTo(d.id, order, deps);
      const key: [number, number, number] = [r9(spread), d.recognizability, tieBreak(seed, d.id)];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
        bestKey = key;
        bestIdx = i;
      }
    });
    order.push((remaining.splice(bestIdx, 1)[0] as Dish).id);
  }
  return order;
}

/** Choose the next card, or null when no eligible unseen dish remains. */
export function selectNextCard(session: DiscoverySession, deps: EngineDeps): CardChoice | null {
  const { eligible } = buildCandidates(deps.catalog, session.constraints);
  const shown = shownDishIds(session);
  const unseen = eligible.filter((d) => !shown.has(d.id));
  if (unseen.length === 0) return null;

  if (deps.policy.cardSelection === "fixed") {
    const order = baselineSequence(eligible, deps, session.seed);
    const next = order.find((id) => !shown.has(id)) as string;
    return { dishId: next, reason: "fixed_sequence", q: null };
  }

  const nReacted = activeReactions(session).length;
  const cfg = deps.policy.nextCard;

  if (nReacted < cfg.coldStartCards) {
    const recognizable = unseen.filter((d) => d.recognizability >= cfg.coldStartMinRecognizability);
    const pool = recognizable.length > 0 ? recognizable : unseen;
    const best = argmax(pool, (d) => [r9(1 - maxSimilarityTo(d.id, shown, deps)), d.recognizability, tieBreak(session.seed, d.id)]);
    return { dishId: best.id, reason: "cold_start_variety", q: null };
  }

  const inputs = scoringInputs(session, deps);
  const scored = unseen.map((d) => {
    const s = scoreDish(d, inputs);
    const appeal = (s.utility + 1) / 2;
    const information = 1 - Math.abs(s.current);
    const coverage = 1 - maxSimilarityTo(d.id, shown, deps);
    const q = r9(cfg.appeal * appeal + cfg.information * information + cfg.coverage * coverage);
    return { d, q };
  });
  const best = argmax(scored, (x) => [x.q, tieBreak(session.seed, x.d.id)]);
  return { dishId: best.d.id, reason: "adaptive_utility", q: best.q };
}

function argmax<T>(items: readonly T[], key: (t: T) => number[]): T {
  let best = items[0] as T;
  let bestKey = key(best);
  for (let i = 1; i < items.length; i++) {
    const item = items[i] as T;
    const k = key(item);
    for (let j = 0; j < k.length; j++) {
      const a = k[j] as number;
      const b = bestKey[j] as number;
      if (a > b) {
        best = item;
        bestKey = k;
        break;
      }
      if (a < b) break;
    }
  }
  return best;
}

export { argmax };
