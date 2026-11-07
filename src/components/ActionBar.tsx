"use client";

import type { ReactNode } from "react";
import type { CardAction } from "./SwipeCard";

/**
 * One row of round card actions. Solo: ⏱ Not for a while · ✕ Not tonight · ↶ Undo · ♥ Sounds good · ★ Love it —
 * "no" on the left, "yes" on the right, getting stronger toward the edges, Undo in the middle.
 * Together: ✕ Not for us · ↶ Undo · ♥ We like it (no strong reactions on a shared screen).
 * Every button has a visible label, which is also its accessible name.
 */
export function ActionBar({
  together,
  disabled,
  canUndo,
  onAction,
  onUndo,
}: {
  together: boolean;
  disabled: boolean;
  canUndo: boolean;
  onAction: (a: CardAction) => void;
  onUndo: () => void;
}) {
  return (
    <div className={`mt-2 grid items-start gap-1 ${together ? "grid-cols-3" : "grid-cols-5"}`} data-testid="action-bar">
      {!together && (
        <RoundButton size="sm" tone="later" label="Not for a while" title="Hide this dish for 30 days (↓ or swipe down)" disabled={disabled} onClick={() => onAction("later")}>
          <ClockIcon />
        </RoundButton>
      )}
      <RoundButton size="lg" tone="no" label={together ? "Not for us" : "Not tonight"} title="← or swipe left" disabled={disabled} onClick={() => onAction("no")}>
        <CrossIcon />
      </RoundButton>
      <RoundButton size="sm" tone="muted" label="Undo" ariaLabel="Undo last reaction" title="Undo (U)" disabled={!canUndo} onClick={onUndo}>
        <UndoIcon />
      </RoundButton>
      <RoundButton size="lg" tone="yes" label={together ? "We like it" : "Sounds good"} title="→ or swipe right" disabled={disabled} onClick={() => onAction("yes")}>
        <HeartIcon />
      </RoundButton>
      {!together && (
        <RoundButton size="sm" tone="love" label="Love it" title="Save as a favourite (↑ or swipe up)" disabled={disabled} onClick={() => onAction("love")}>
          <StarIcon />
        </RoundButton>
      )}
    </div>
  );
}

const TONES = {
  yes: "text-yes ring-yes/45",
  no: "text-no ring-no/45",
  love: "text-love ring-love/45",
  later: "text-later ring-later/45",
  muted: "text-muted ring-line",
} as const;

function RoundButton({
  size,
  tone,
  label,
  ariaLabel,
  title,
  disabled,
  onClick,
  children,
}: {
  size: "sm" | "lg";
  tone: keyof typeof TONES;
  label: string;
  ariaLabel?: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className="group flex min-w-0 flex-col items-center gap-1 rounded-2xl pb-0.5 disabled:opacity-35"
    >
      <span aria-hidden="true" className="grid h-14 place-items-center">
        <span
          className={`grid place-items-center rounded-full bg-surface shadow-[0_4px_12px_-6px_rgba(0,0,0,0.4)] ring-2 transition-transform group-active:scale-90 ${TONES[tone]} ${
            size === "lg" ? "h-14 w-14 [&>svg]:h-7 [&>svg]:w-7" : "h-11 w-11 [&>svg]:h-5 [&>svg]:w-5"
          }`}
        >
          {children}
        </span>
      </span>
      <span className={`text-center text-[11.5px] font-semibold leading-tight ${TONES[tone].split(" ")[0]}`}>{label}</span>
    </button>
  );
}

const svg = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.4, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function CrossIcon() {
  return (
    <svg {...svg} strokeWidth={3}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg {...svg}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
function UndoIcon() {
  return (
    <svg {...svg}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 010 11H11" />
    </svg>
  );
}
