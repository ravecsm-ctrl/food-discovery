/**
 * Pure, immutable solo-session state (ENG-016/ENG-017, R-007, ETD §4.4).
 * Every transition returns a new object; nothing here touches the browser or clock directly.
 */
import type { CardExposure, ConfirmedMeal, ReactionStrength, ReactionValue, Reaction, SessionConstraints } from "./types.ts";

export type SessionMode = "solo" | "together";

/**
 * Together Mode only: a recent meal the pair typed in for tonight's decision, and who had it.
 * Session-only — never written to anyone's meal history or synced (PRRD R-022).
 */
export interface TogetherMeal extends ConfirmedMeal {
  who: "a" | "b" | "both";
}

export interface DiscoverySession {
  sessionId: string;
  /** "together" = two people sharing one phone (PRRD J-03). */
  mode: SessionMode;
  /** Together Mode recent meals (session-only). Empty for solo sessions. */
  togetherMeals: TogetherMeal[];
  seed: number;
  policyId: string;
  catalogVersion: string;
  constraints: SessionConstraints;
  startedAt: string;
  exposures: CardExposure[];
  reactions: Reaction[];
  /** Effective-card count at which the current discovery round ends (ETD §8.9). */
  roundEndsAt: number;
  rounds: number;
  /** Monotonic counter for action-group ids. */
  actionCounter: number;
}

export function createSession(args: {
  sessionId: string;
  seed: number;
  policyId: string;
  catalogVersion: string;
  constraints: SessionConstraints;
  now: string;
  initialBudget: number;
  mode?: SessionMode;
  togetherMeals?: TogetherMeal[];
}): DiscoverySession {
  return {
    sessionId: args.sessionId,
    mode: args.mode ?? "solo",
    togetherMeals: args.mode === "together" ? (args.togetherMeals ?? []) : [],
    seed: args.seed,
    policyId: args.policyId,
    catalogVersion: args.catalogVersion,
    constraints: args.constraints,
    startedAt: args.now,
    exposures: [],
    reactions: [],
    roundEndsAt: args.initialBudget,
    rounds: 1,
    actionCounter: 0,
  };
}

export function activeReactions(s: DiscoverySession): Reaction[] {
  return s.reactions.filter((r) => r.active);
}

/** The card awaiting a reaction, if any. */
export function currentExposure(s: DiscoverySession): CardExposure | null {
  const reacted = new Set(activeReactions(s).map((r) => r.exposureId));
  for (let i = s.exposures.length - 1; i >= 0; i--) {
    const e = s.exposures[i] as CardExposure;
    if (!e.withdrawn && !reacted.has(e.exposureId)) return e;
  }
  return null;
}

/** Dishes currently counted as shown (withdrawn cards are not). */
export function shownDishIds(s: DiscoverySession): Set<string> {
  return new Set(s.exposures.filter((e) => !e.withdrawn).map((e) => e.dishId));
}

/** Cards with an active reaction. A disagreement (two attributed reactions) still counts as one card. */
export function effectiveCardCount(s: DiscoverySession): number {
  return new Set(activeReactions(s).map((r) => r.exposureId)).size;
}

export function addExposure(s: DiscoverySession, dishId: string, now: string, selectionProbability = 1): DiscoverySession {
  if (currentExposure(s)) throw new Error("A card is already awaiting a reaction");
  if (shownDishIds(s).has(dishId)) throw new Error(`Dish ${dishId} was already shown in this session`);
  const position = s.exposures.length + 1;
  const exposure: CardExposure = {
    exposureId: `${s.sessionId}:x${position}`,
    dishId,
    position,
    shownAt: now,
    withdrawn: false,
    selectionProbability,
  };
  return { ...s, exposures: [...s.exposures, exposure] };
}

export function recordReaction(
  s: DiscoverySession,
  value: ReactionValue,
  now: string,
  strength: ReactionStrength = "ordinary",
): DiscoverySession {
  const exposure = currentExposure(s);
  if (!exposure) throw new Error("No card is awaiting a reaction");
  const n = s.actionCounter + 1;
  const reaction: Reaction = {
    reactionId: `${s.sessionId}:r${n}`,
    actionGroupId: `${s.sessionId}:g${n}`,
    exposureId: exposure.exposureId,
    dishId: exposure.dishId,
    value,
    strength,
    active: true,
    recordedAt: now,
    invalidatedAt: null,
  };
  return { ...s, reactions: [...s.reactions, reaction], actionCounter: n };
}

/**
 * Together Mode disagreement (PRRD J-03 steps 3–4): only one person wants this dish.
 * Records two attributed reactions in ONE action group, so a single Undo removes both.
 */
export function recordSplitReaction(s: DiscoverySession, wantedBy: "a" | "b", now: string): DiscoverySession {
  if (s.mode !== "together") throw new Error("Split reactions exist only in Together Mode");
  const exposure = currentExposure(s);
  if (!exposure) throw new Error("No card is awaiting a reaction");
  const n = s.actionCounter + 1;
  const mk = (participant: "a" | "b"): Reaction => ({
    reactionId: `${s.sessionId}:r${n}${participant}`,
    actionGroupId: `${s.sessionId}:g${n}`,
    exposureId: exposure.exposureId,
    dishId: exposure.dishId,
    value: participant === wantedBy ? "yes" : "no",
    strength: "ordinary",
    participant,
    active: true,
    recordedAt: now,
    invalidatedAt: null,
  });
  return { ...s, reactions: [...s.reactions, mk("a"), mk("b")], actionCounter: n };
}

export function canUndo(s: DiscoverySession): boolean {
  return s.reactions.some((r) => r.active);
}

/**
 * Undo the latest logical reaction: invalidate every reaction in its action group,
 * withdraw the card shown after it, and make the reacted card current again.
 * Invalidated evidence stays in the log for evaluation but has no ranking effect.
 */
export function undoLastReaction(s: DiscoverySession, now: string): DiscoverySession {
  const last = [...s.reactions].reverse().find((r) => r.active);
  if (!last) return s;
  const pending = currentExposure(s);
  return {
    ...s,
    reactions: s.reactions.map((r) =>
      r.actionGroupId === last.actionGroupId && r.active ? { ...r, active: false, invalidatedAt: now } : r,
    ),
    exposures: s.exposures.map((e) => (pending && e.exposureId === pending.exposureId ? { ...e, withdrawn: true } : e)),
  };
}

/** Start another discovery round after results (users may always continue). */
export function continueDiscovery(s: DiscoverySession, extraBudget: number): DiscoverySession {
  return { ...s, roundEndsAt: effectiveCardCount(s) + extraBudget, rounds: s.rounds + 1 };
}
