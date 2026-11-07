/**
 * Strong preferences — "Love it" and "Not for a while" on a card (owner request 2026-11-07; the PRRD's
 * deferred strong-preference feedback, now authorized). Unlike ordinary swipes, these are remembered:
 *
 * - favourite ("Love it"): the dish is a long-term favourite. It gently shapes future suggestions through
 *   the taste profile (half the weight of a 5★ meal you actually ate — choosing is not eating).
 * - snooze ("Not for a while"): the dish is hidden for `snoozeDays`, then it can come back. While hidden,
 *   similar dishes are nudged down a little.
 * - never ("Never show again"): hidden until the person undoes it in Your data.
 *
 * These are TASTE choices, never dietary or safety rules: hard exclusions stay with declared restrictions.
 * Ordinary "Not tonight" / "Sounds good" stay session-only. One preference per dish; the latest wins.
 * Together Mode uses none of this (no stored personal history on a shared screen).
 */
import type { ISODateTime } from "./types.ts";

export const STRONG_PREFS_V0 = {
  id: "strong-prefs-v0",
  snoozeDays: 30,
  /** Taste-profile weight of a favourite relative to a 5★ eaten meal. */
  favouriteWeight: 0.5,
  /** Taste-profile weight of a hidden dish relative to a 1★ eaten meal (dislike damping still applies). */
  hiddenWeight: 0.5,
} as const;

export type StrongPrefKind = "favourite" | "snooze" | "never";

export interface StrongPreference {
  dishId: string;
  kind: StrongPrefKind;
  /** When the person chose it. */
  at: ISODateTime;
  /** Snooze only: when the dish may show again. */
  until?: ISODateTime | null;
}

const DAY_MS = 86_400_000;

export function snoozeUntil(now: ISODateTime): ISODateTime {
  return new Date(Date.parse(now) + STRONG_PREFS_V0.snoozeDays * DAY_MS).toISOString();
}

/** A snooze whose time has passed no longer counts for anything. */
export function isActive(p: StrongPreference, now: ISODateTime): boolean {
  if (p.kind !== "snooze") return true;
  const u = p.until ? Date.parse(p.until) : NaN;
  return !Number.isNaN(u) && u > Date.parse(now);
}

/** Latest preference per dish, active ones only, in a stable order. */
export function activePrefs(prefs: readonly StrongPreference[], now: ISODateTime): StrongPreference[] {
  const latest = new Map<string, StrongPreference>();
  for (const p of prefs) {
    const prev = latest.get(p.dishId);
    if (!prev || p.at >= prev.at) latest.set(p.dishId, p);
  }
  return [...latest.values()].filter((p) => isActive(p, now)).sort((a, b) => a.dishId.localeCompare(b.dishId));
}

/** Dishes the person chose not to see right now (excluded before ranking, but never as a dietary rule). */
export function hiddenDishIds(prefs: readonly StrongPreference[], now: ISODateTime): string[] {
  return activePrefs(prefs, now)
    .filter((p) => p.kind !== "favourite")
    .map((p) => p.dishId);
}

export function favouriteDishIds(prefs: readonly StrongPreference[], now: ISODateTime): string[] {
  return activePrefs(prefs, now)
    .filter((p) => p.kind === "favourite")
    .map((p) => p.dishId);
}
