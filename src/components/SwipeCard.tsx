"use client";

import { useRef, useState } from "react";
import type { Dish, SafetyAssessment } from "@/engine";
import { DishArt } from "./DishArt";
import { DishLabel, SafetyNote } from "./DishInfo";

/** Distance (px) a drag must travel to count, or a shorter flick faster than FLICK px/ms. */
const THRESHOLD = 100;
const FLICK = 0.55;
const FLICK_MIN = 50;
/** Movement below this is a tap, not a drag (tapping the picture opens Details). */
const TAP_SLOP = 8;

/** One card action. "love" / "later" are the solo strong reactions ("Love it" / "Not for a while"). */
export type CardAction = "yes" | "no" | "love" | "later";

const STAMPS: Record<CardAction, { text: string; cls: string; pos: string }> = {
  yes: { text: "Sounds good", cls: "border-yes text-yes", pos: "right-4 top-12 rotate-6" },
  no: { text: "Not tonight", cls: "border-no text-no", pos: "left-4 top-12 -rotate-6" },
  love: { text: "Love it", cls: "border-love text-love", pos: "inset-x-0 bottom-6 mx-auto w-max -rotate-3" },
  later: { text: "Not for a while", cls: "border-later text-later", pos: "inset-x-0 top-12 mx-auto w-max rotate-3" },
};

/** Where the card flies when it leaves. */
const EXIT: Record<CardAction, [number, number]> = { yes: [640, 40], no: [-640, 40], love: [0, -900], later: [0, 900] };

/**
 * Draggable food card (ENG-016, R-003). Right = "Sounds good", left = "Not tonight"; in solo sessions
 * up = "Love it" and down = "Not for a while". Gestures are a convenience only: every action is also a
 * button and a key.
 */
export function SwipeCard({
  dish,
  safety,
  leaving,
  allowStrong,
  onSwipe,
  onDetails,
}: {
  dish: Dish;
  safety: SafetyAssessment;
  leaving: CardAction | null;
  allowStrong: boolean;
  onSwipe: (action: CardAction) => void;
  onDetails: () => void;
}) {
  const [d, setD] = useState<[number, number]>([0, 0]);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; onArt: boolean } | null>(null);
  const last = useRef<{ x: number; y: number; t: number; vx: number; vy: number }>({ x: 0, y: 0, t: 0, vx: 0, vy: 0 });

  const [dx, dy] = leaving ? EXIT[leaving] : d;
  const rotate = leaving === "love" || leaving === "later" ? 0 : dx / 18;
  const vertical = allowStrong && Math.abs(dy) > Math.abs(dx);
  const pull: Record<CardAction, number> = {
    yes: leaving === "yes" ? 1 : vertical ? 0 : dx / THRESHOLD,
    no: leaving === "no" ? 1 : vertical ? 0 : -dx / THRESHOLD,
    love: leaving === "love" ? 1 : vertical ? -dy / THRESHOLD : 0,
    later: leaving === "later" ? 1 : vertical ? dy / THRESHOLD : 0,
  };

  const decide = (mx: number, my: number, vx: number, vy: number): CardAction | null => {
    const isVertical = allowStrong && Math.abs(my) > Math.abs(mx);
    if (isVertical) {
      if (Math.abs(my) >= THRESHOLD || (Math.abs(my) >= FLICK_MIN && Math.abs(vy) >= FLICK)) return my < 0 ? "love" : "later";
      return null;
    }
    if (Math.abs(mx) >= THRESHOLD || (Math.abs(mx) >= FLICK_MIN && Math.abs(vx) >= FLICK)) return mx > 0 ? "yes" : "no";
    return null;
  };

  return (
    <article
      aria-label={dish.name}
      data-testid="food-card"
      data-dish-id={dish.id}
      className={`animate-card-in absolute inset-0 flex select-none flex-col overflow-hidden rounded-[28px] bg-surface shadow-[0_18px_50px_-18px_rgba(60,30,10,0.45)] ring-1 ring-line ${
        allowStrong ? "touch-none" : "touch-pan-y"
      }`}
      style={{
        transform: `translate(${dx}px, ${dy}px) rotate(${rotate}deg)`,
        transition: dragging ? "none" : "transform 260ms cubic-bezier(.2,.8,.2,1), opacity 260ms",
        opacity: leaving ? 0 : 1,
        cursor: dragging ? "grabbing" : "grab",
      }}
      onPointerDown={(e) => {
        if (leaving || (e.target as HTMLElement).closest("button")) return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, onArt: !!(e.target as HTMLElement).closest("[data-card-art]") };
        last.current = { x: e.clientX, y: e.clientY, t: e.timeStamp, vx: 0, vy: 0 };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current || start.current.id !== e.pointerId) return;
        const dt = Math.max(1, e.timeStamp - last.current.t);
        last.current = {
          x: e.clientX,
          y: e.clientY,
          t: e.timeStamp,
          vx: (e.clientX - last.current.x) / dt,
          vy: (e.clientY - last.current.y) / dt,
        };
        const mx = e.clientX - start.current.x;
        const my = e.clientY - start.current.y;
        setD([mx, allowStrong ? my : my * 0.15]);
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const mx = e.clientX - s.x;
        const my = e.clientY - s.y;
        start.current = null;
        setDragging(false);
        const stale = e.timeStamp - last.current.t > 80; // finger stopped before lifting: no flick
        const action = decide(mx, my, stale ? 0 : last.current.vx, stale ? 0 : last.current.vy);
        if (action) {
          setD([mx, my]);
          onSwipe(action);
          return;
        }
        setD([0, 0]);
        if (s.onArt && Math.hypot(mx, my) < TAP_SLOP) onDetails();
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
        setD([0, 0]);
      }}
    >
      <div className="relative min-h-0 flex-1" data-card-art>
        <DishArt dish={dish} />
        {(Object.keys(STAMPS) as CardAction[])
          .filter((a) => allowStrong || (a !== "love" && a !== "later"))
          .map((a) => (
            <span
              key={a}
              className={`pointer-events-none absolute rounded-xl border-[3px] bg-surface/85 px-3 py-1 font-display text-xl font-bold uppercase ${STAMPS[a].cls} ${STAMPS[a].pos}`}
              style={{ opacity: Math.max(0, Math.min(1, pull[a])) }}
              aria-hidden="true"
              data-testid={`stamp-${a}`}
            >
              {STAMPS[a].text}
            </span>
          ))}
      </div>
      <div className="space-y-2 p-4 pb-4.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DishLabel dish={dish} className="mb-0.5" />
            <h2 className="font-display text-[1.65rem] font-semibold leading-tight">{dish.name}</h2>
          </div>
          <button
            type="button"
            onClick={onDetails}
            className="mt-1 shrink-0 rounded-full bg-surface-2 px-3.5 py-2 text-sm font-medium"
            aria-label={`Details about ${dish.name}`}
          >
            Details
          </button>
        </div>
        <p className="line-clamp-2 text-[15px] leading-snug text-muted">{dish.description}</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Characteristics">
          {dish.tags.map((t) => (
            <li key={t} className="rounded-full bg-surface-2 px-2.5 py-1 text-[13px] font-medium">
              {t}
            </li>
          ))}
        </ul>
        <SafetyNote safety={safety} />
      </div>
    </article>
  );
}
