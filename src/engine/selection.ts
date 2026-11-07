/**
 * Next-card policies (ENG-012 fixed baseline, ENG-013 adaptive; R-004, R-014, ETD §8.8).
 * Both policies draw from the SAME eligible candidate set (ALG-018).
 */
import { buildCandidates } from "./eligibility.ts";
import { depsForSession } from "./together.ts";
import { mealFit } from "./meal-time.ts";
import { dishFatigue, recentLoad } from "./fatigue.ts";
import type { PolicyConfig } from "./policy.ts";
import { tieBreak } from "./rng.ts";
import { recentConfirmedMeals, scoreDish, type ScoringInputs } from "./scoring.ts";
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
    ...(session.constraints.mealTime ? { mealTime: session.constraints.mealTime } : {}),
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
const sequenceCache = new WeakMap<Catalog, Map<string, string[]>>();

export function baselineSequence(eligible: readonly Dish[], deps: EngineDeps, seed: number): string[] {
  // Pure function of (catalog, eligible set, seed, similarity weights) — memoized so each swipe is O(1).
  let byKey = sequenceCache.get(deps.catalog);
  if (!byKey) {
    byKey = new Map();
    sequenceCache.set(deps.catalog, byKey);
  }
  const key = `${seed}|${JSON.stringify(deps.policy.similarityKindWeights)}|${eligible.map((d) => d.id).join(",")}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  // Greedy max-min diversity. maxSim[i] = max similarity of remaining[i] to anything already ordered,
  // updated incrementally with only the newest pick (O(n²) instead of O(n³); identical result).
  const remaining = [...eligible];
  const maxSim = remaining.map(() => 0);
  const order: string[] = [];
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestKey: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    remaining.forEach((d, i) => {
      const spread = order.length === 0 ? 1 : 1 - (maxSim[i] as number);
      const k: [number, number, number] = [r9(spread), d.recognizability, tieBreak(seed, d.id)];
      if (k[0] > bestKey[0] || (k[0] === bestKey[0] && (k[1] > bestKey[1] || (k[1] === bestKey[1] && k[2] > bestKey[2])))) {
        bestKey = k;
        bestIdx = i;
      }
    });
    const picked = (remaining.splice(bestIdx, 1)[0] as Dish).id;
    maxSim.splice(bestIdx, 1);
    order.push(picked);
    remaining.forEach((d, i) => {
      maxSim[i] = Math.max(maxSim[i] as number, dishSimilarity(deps.catalog, d.id, picked, deps.policy.similarityKindWeights));
    });
  }
  if (byKey.size > 50) byKey.clear();
  byKey.set(key, order);
  return order;
}

/** Choose the next card, or null when no eligible unseen dish remains. */
export function selectNextCard(session: DiscoverySession, deps: EngineDeps): CardChoice | null {
  deps = depsForSession(session, deps);
  const { eligible } = buildCandidates(deps.catalog, session.constraints);
  const shown = shownDishIds(session);
  const unseen = eligible.filter((d) => !shown.has(d.id));
  if (unseen.length === 0) return null;

  // Taste fatigue v2: dishes confirmed eaten in the window go to the back of the queue in BOTH card
  // policies (not excluded — a repeat may still be wanted), keeping the arms comparable.
  // People who set "I like routine" (varietySeeking ≤ 0.5) keep normal card order; only the scoring penalty applies.
  const fatigueOn = deps.policy.fatigue.enabled && (deps.user.varietySeeking ?? 1) > 0.5;
  const eatenRecently = fatigueOn
    ? new Set(recentConfirmedMeals(deps.user.confirmedMeals, deps.now, deps.policy.fatigue.windowDays).map((m) => m.dishId))
    : new Set<string | null>();
  // Meal-time fit (v3+): clearly unsuitable dishes (e.g. a sharing platter at breakfast) wait at the back
  // of the queue in BOTH card policies — never excluded, so they still appear if everything else is seen.
  const mt = session.constraints.mealTime;
  const mtCfg = deps.policy.mealTime;
  const fitFor = (d: Dish) => (mtCfg.enabled && mt ? mealFit(d, mt) : 0);
  const okForTime = (d: Dish) => !mtCfg.enabled || !mt || fitFor(d) >= mtCfg.demoteBelow;
  const fresh = unseen.filter((d) => !eatenRecently.has(d.id) && okForTime(d));

  if (deps.policy.cardSelection === "fixed") {
    const order = baselineSequence(eligible, deps, session.seed);
    const ok = new Set(fresh.map((d) => d.id));
    const next = (order.find((id) => ok.has(id)) ?? order.find((id) => !shown.has(id) && !eatenRecently.has(id)) ?? order.find((id) => !shown.has(id))) as string;
    return { dishId: next, reason: "fixed_sequence", q: null };
  }

  const nReacted = activeReactions(session).length;
  const cfg = deps.policy.nextCard;

  if (nReacted < cfg.coldStartCards) {
    let base = fresh.length > 0 ? fresh : unseen;
    if (fatigueOn) {
      const load = recentLoad(deps.catalog, deps.user.confirmedMeals, deps.now, deps.policy.fatigue);
      const notTired = base.filter((d) => dishFatigue(d, load, deps.policy.fatigue) <= 0.5);
      if (notTired.length > 0) base = notTired;
    }
    // First impressions fit the meal: when enough good fits exist, cold-start cards come from them.
    if (mtCfg.enabled && mt) {
      const fitting = base.filter((d) => fitFor(d) >= 0.4);
      if (fitting.length >= cfg.coldStartCards * 2) base = fitting;
    }
    const recognizable = base.filter((d) => d.recognizability >= cfg.coldStartMinRecognizability);
    const pool = recognizable.length > 0 ? recognizable : base;
    const best = argmax(pool, (d) => [r9(1 - maxSimilarityTo(d.id, shown, deps)), d.recognizability, tieBreak(session.seed, d.id)]);
    return { dishId: best.id, reason: "cold_start_variety", q: null };
  }

  const inputs = scoringInputs(session, deps);
  const raw = (fresh.length > 0 ? fresh : unseen).map((d) => {
    const s = scoreDish(d, inputs);
    const uncertainty = 1 - Math.abs(s.current);
    return {
      d,
      appeal: (s.utility + 1) / 2,
      information: cfg.informationProxy === "evidence_weighted" ? uncertainty * s.currentEvidence : uncertainty,
      coverage: 1 - maxSimilarityTo(d.id, shown, deps),
    };
  });
  const norm = cfg.termNormalization === "minmax" ? minMaxNormalizer(raw) : (x: (typeof raw)[number]) => x;
  const scored = raw.map((x) => {
    const n = norm(x);
    return { d: x.d, q: r9(cfg.appeal * n.appeal + cfg.information * n.information + cfg.coverage * n.coverage) };
  });
  const best = argmax(scored, (x) => [x.q, tieBreak(session.seed, x.d.id)]);
  return { dishId: best.d.id, reason: "adaptive_utility", q: best.q };
}

type Terms = { appeal: number; information: number; coverage: number };

/** Rescale each term to 0..1 across the candidate pool (a constant term becomes 0.5). */
function minMaxNormalizer<T extends Terms>(rows: readonly T[]): (x: T) => Terms {
  const keys = ["appeal", "information", "coverage"] as const;
  const lo = Object.fromEntries(keys.map((k) => [k, Math.min(...rows.map((r) => r[k]))])) as Terms;
  const hi = Object.fromEntries(keys.map((k) => [k, Math.max(...rows.map((r) => r[k]))])) as Terms;
  const scale = (k: keyof Terms, v: number) => (hi[k] - lo[k] < 1e-12 ? 0.5 : (v - lo[k]) / (hi[k] - lo[k]));
  return (x) => ({ appeal: scale("appeal", x.appeal), information: scale("information", x.information), coverage: scale("coverage", x.coverage) });
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
