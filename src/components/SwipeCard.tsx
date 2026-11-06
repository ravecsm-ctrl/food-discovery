"use client";

import { useRef, useState } from "react";
import type { Dish, ReactionValue, SafetyAssessment } from "@/engine";
import { DishArt } from "./DishArt";
import { DishLabel, SafetyNote } from "./DishInfo";

const THRESHOLD = 110;

/**
 * Draggable food card (ENG-016, R-003). Swipe right = "Sounds good", left = "Not tonight".
 * Gestures are a convenience only; the same actions are available as buttons and keys.
 */
export function SwipeCard({
  dish,
  safety,
  leaving,
  onSwipe,
  onDetails,
}: {
  dish: Dish;
  safety: SafetyAssessment;
  leaving: ReactionValue | null;
  onSwipe: (value: ReactionValue) => void;
  onDetails: () => void;
}) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);

  const offset = leaving === "yes" ? 640 : leaving === "no" ? -640 : dx;
  const rotate = offset / 18;
  const yesOpacity = Math.max(0, Math.min(1, offset / THRESHOLD));
  const noOpacity = Math.max(0, Math.min(1, -offset / THRESHOLD));

  return (
    <article
      aria-label={dish.name}
      data-testid="food-card"
      data-dish-id={dish.id}
      className="animate-card-in absolute inset-0 flex touch-pan-y select-none flex-col overflow-hidden rounded-[28px] bg-surface shadow-[0_18px_50px_-18px_rgba(60,30,10,0.45)] ring-1 ring-line"
      style={{
        transform: `translateX(${offset}px) rotate(${rotate}deg)`,
        transition: dragging ? "none" : "transform 240ms cubic-bezier(.2,.8,.2,1), opacity 240ms",
        opacity: leaving ? 0 : 1,
        cursor: dragging ? "grabbing" : "grab",
      }}
      onPointerDown={(e) => {
        if (leaving || (e.target as HTMLElement).closest("button")) return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current || start.current.id !== e.pointerId) return;
        setDx(e.clientX - start.current.x);
      }}
      onPointerUp={(e) => {
        if (!start.current || start.current.id !== e.pointerId) return;
        const moved = e.clientX - start.current.x;
        start.current = null;
        setDragging(false);
        if (Math.abs(moved) >= THRESHOLD) onSwipe(moved > 0 ? "yes" : "no");
        else setDx(0);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDragging(false);
        setDx(0);
      }}
    >
      <div className="relative min-h-0 flex-1">
        <DishArt dish={dish} />
        <span
          className="pointer-events-none absolute right-4 top-4 rotate-6 rounded-xl border-[3px] border-yes bg-surface/85 px-3 py-1 font-display text-xl font-bold uppercase text-yes"
          style={{ opacity: yesOpacity }}
          aria-hidden="true"
        >
          Sounds good
        </span>
        <span
          className="pointer-events-none absolute left-4 top-12 -rotate-6 rounded-xl border-[3px] border-no bg-surface/85 px-3 py-1 font-display text-xl font-bold uppercase text-no"
          style={{ opacity: noOpacity }}
          aria-hidden="true"
        >
          Not tonight
        </span>
      </div>
      <div className="space-y-2.5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DishLabel dish={dish} className="mb-0.5" />
            <h2 className="font-display text-[1.75rem] font-semibold leading-tight">{dish.name}</h2>
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
        <p className="text-[15px] leading-snug text-muted">{dish.description}</p>
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
