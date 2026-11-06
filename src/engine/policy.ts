import { FATIGUE_V2, type FatigueConfig } from "./fatigue.ts";

/**
 * Versioned, configurable recommendation policies (ENG-005, ETD §8).
 *
 * Every coefficient below is a provisional engineering default from ETD §8 (TD-008),
 * NOT a validated scientific model. Change values only by creating a new policy id.
 */

export type CardSelectionMode = "fixed" | "adaptive";

export interface PolicyConfig {
  id: string;
  /** Human label for the prototype evaluation screen. */
  label: string;
  /** PRRD §16.4 experiment arm this policy approximates. */
  experimentArm: string;
  cardSelection: CardSelectionMode;
  /** ETD §8.6 U = P·wP + C·wC + X·wX + N·wN + R */
  utilityWeights: { stable: number; current: number; softContext: number; novelty: number };
  reactionWeights: { ordinary: number; explicit: number; explicitCap: number };
  /**
   * ETD §8.4 current appetite.
   * - "global": C = Σ w·sim / Σ|w|   (ETD literal; dilutes a Yes when many unrelated Nos exist)
   * - "kernel": C = Σ w·k / (prior + Σ|w|·k), k = max(0, (sim − floor)/(1 − floor))^exponent
   *   (default; documented deviation D-03 in docs/m1-implementation-notes.md)
   */
  currentAppetite: { normalization: "global" | "kernel"; similarityFloor: number; kernelExponent: number; priorStrength: number };
  /** Taste fatigue v2 (attribute-level). When enabled it replaces the v0 `exposure` heuristic. */
  fatigue: FatigueConfig;
  /** Offer quick picks from recent meals before swiping. */
  quickPicks: boolean;
  /** ETD §8.5 conservative exposure heuristic. */
  exposure: {
    enabled: boolean;
    halfLifeHours: number;
    windowDays: number;
    exposureCap: number;
    penaltyPerUnit: number;
    maxPenalty: number;
    fullCoverageMeals: number;
  };
  /** Per-kind weights for multi-attribute similarity (ENG-008). */
  similarityKindWeights: Record<string, number>;
  /** ETD §8.8 Q = appeal·a + info·b + coverage·c */
  nextCard: {
    appeal: number;
    information: number;
    coverage: number;
    /**
     * "affine": appeal = (U+1)/2 (ETD literal). "minmax": each term rescaled to 0..1 across the
     * current candidate pool so the 0.60/0.25/0.15 weights actually discriminate (deviation D-05).
     */
    termNormalization: "affine" | "minmax";
    /**
     * "uncertainty": 1 − |C| (ETD literal; favours dishes with NO evidence, i.e. irrelevant ones).
     * "evidence_weighted": (1 − |C|) × evidence — favours dishes where liked and rejected signals
     * compete, and gives unrelated dishes 0 (ETD §8.8 intent; deviation D-05).
     */
    informationProxy: "uncertainty" | "evidence_weighted";
    /** Cold start: first N cards are chosen from recognizable dishes, maximizing variety. */
    coldStartCards: number;
    coldStartMinRecognizability: number;
  };
  /** ETD §8.9 shortlist + readiness parameters. */
  shortlist: {
    maxItems: number;
    nearDuplicateSimilarity: number;
    minUtility: number;
    minPositiveEvidence: number;
    strongMatchUtility: number;
  };
  session: {
    initialBudget: number;
    minCardsForReadinessPrompt: number;
  };
  /** Reason-code evidence thresholds (ENG-015). */
  reasons: {
    currentPositiveMin: number;
    supportingSimilarityMin: number;
    stableMatchMin: number;
    noveltyMin: number;
    varietyMaxSimilarityToRecent: number;
    minReactionsForEvidence: number;
  };
}

type SharedParams = Pick<
  PolicyConfig,
  "utilityWeights" | "reactionWeights" | "currentAppetite" | "similarityKindWeights" | "nextCard" | "shortlist" | "session" | "reasons"
>;

/** Returns a fresh copy so policies never share mutable objects. */
function shared(nextCardMode: Pick<PolicyConfig["nextCard"], "termNormalization" | "informationProxy">): SharedParams {
  return {
  utilityWeights: { stable: 0.35, current: 0.45, softContext: 0.1, novelty: 0.1 },
  reactionWeights: { ordinary: 1, explicit: 1.5, explicitCap: 2 },
  currentAppetite: { normalization: "kernel", similarityFloor: 0.15, kernelExponent: 2, priorStrength: 0.5 },
  similarityKindWeights: {
    cuisine: 0.1,
    ingredient: 0.22,
    method: 0.16,
    flavor: 0.2,
    texture: 0.14,
    structure: 0.14,
    richness: 0.04,
  },
  nextCard: { appeal: 0.6, information: 0.25, coverage: 0.15, ...nextCardMode, coldStartCards: 3, coldStartMinRecognizability: 0.8 },
  shortlist: {
    maxItems: 3,
    nearDuplicateSimilarity: 0.8,
    minUtility: 0.12,
    minPositiveEvidence: 0.2,
    strongMatchUtility: 0.3,
  },
  session: { initialBudget: 10, minCardsForReadinessPrompt: 3 },
  reasons: {
    currentPositiveMin: 0.2,
    supportingSimilarityMin: 0.45,
    stableMatchMin: 0.2,
    noveltyMin: 0.05,
    varietyMaxSimilarityToRecent: 0.35,
    minReactionsForEvidence: 3,
  },
  };
}

const EXPOSURE_ON: PolicyConfig["exposure"] = {
  enabled: true,
  halfLifeHours: 48,
  windowDays: 7,
  exposureCap: 2,
  penaltyPerUnit: 0.06,
  maxPenalty: 0.12,
  fullCoverageMeals: 4,
};

const EXPOSURE_OFF: PolicyConfig["exposure"] = { ...EXPOSURE_ON, enabled: false };
const FATIGUE_OFF: FatigueConfig = { ...FATIGUE_V2, enabled: false };

/** ETD §8.8 taken literally. Kept for comparison; see D-05 for why it under-adapts. */
const ETD_LITERAL = { termNormalization: "affine", informationProxy: "uncertainty" } as const;
/** Default from v1: normalized terms + evidence-weighted information proxy. */
const NORMALIZED = { termNormalization: "minmax", informationProxy: "evidence_weighted" } as const;

export const POLICIES: Record<string, PolicyConfig> = {
  "baseline-fixed-v0": {
    id: "baseline-fixed-v0",
    label: "Baseline — fixed diverse sequence",
    experimentArm: "A/B (fixed curated sequence; shortlist ranked from reactions)",
    cardSelection: "fixed",
    exposure: EXPOSURE_OFF,
    fatigue: FATIGUE_OFF,
    quickPicks: false,
    ...shared(NORMALIZED),
  },
  "adaptive-v0": {
    id: "adaptive-v0",
    label: "Adaptive (ETD-literal next-card terms) — reference only",
    experimentArm: "C (adaptive card selection, ETD §8.8 literal)",
    cardSelection: "adaptive",
    exposure: EXPOSURE_OFF,
    fatigue: FATIGUE_OFF,
    quickPicks: false,
    ...shared(ETD_LITERAL),
  },
  "adaptive-v1": {
    id: "adaptive-v1",
    label: "Adaptive — next card responds to reactions",
    experimentArm: "C (adaptive card selection)",
    cardSelection: "adaptive",
    exposure: EXPOSURE_OFF,
    fatigue: FATIGUE_OFF,
    quickPicks: false,
    ...shared(NORMALIZED),
  },
  "adaptive-exposure-v1": {
    id: "adaptive-exposure-v1",
    label: "Adaptive + recent-meal exposure",
    experimentArm: "D (adds conservative recent-food exposure)",
    cardSelection: "adaptive",
    exposure: EXPOSURE_ON,
    fatigue: FATIGUE_OFF,
    quickPicks: false,
    ...shared(NORMALIZED),
  },
  "baseline-fixed-v2": {
    id: "baseline-fixed-v2",
    label: "Baseline + taste fatigue — fixed diverse sequence",
    experimentArm: "A/B with taste fatigue v2 and quick picks",
    cardSelection: "fixed",
    exposure: EXPOSURE_OFF,
    fatigue: FATIGUE_V2,
    quickPicks: true,
    ...shared(NORMALIZED),
  },
  "adaptive-v2": {
    id: "adaptive-v2",
    label: "Adaptive + taste fatigue — next card responds to reactions",
    experimentArm: "C/D with taste fatigue v2 and quick picks",
    cardSelection: "adaptive",
    exposure: EXPOSURE_OFF,
    fatigue: FATIGUE_V2,
    quickPicks: true,
    ...shared(NORMALIZED),
  },
};

/** Policies used for new sessions under rotation (the comparison arms). */
export const ACTIVE_POLICY_IDS = ["baseline-fixed-v2", "adaptive-v2"];

export const POLICY_IDS = Object.keys(POLICIES);

export function getPolicy(id: string): PolicyConfig {
  const p = POLICIES[id];
  if (!p) throw new Error(`Unknown policy id: ${id}`);
  return p;
}
