"use client";

import { useState } from "react";
import type { Dish } from "@/engine";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Short credit shown on the card, e.g. "Photo: J. Cruz · CC BY-SA 4.0". Full details are in Details. */
export function photoCredit(dish: Dish): string | null {
  if (!dish.photo) return null;
  return `Photo: ${dish.photo.author} · ${dish.photo.license}`;
}

/**
 * Dish picture (PRRD §9.5). A rights-cleared photo kept with the app (with its credit) when the catalog has
 * one; otherwise a clearly labelled illustration placeholder. Never hot-linked, scraped or unverified images.
 * Decorative only — the dish name is real text.
 */
const PALETTES: Record<string, [string, string]> = {
  filipino: ["#ffb347", "#e8572a"],
  japanese: ["#ffd6c9", "#c8102e"],
  italian: ["#d8efc6", "#c0392b"],
  korean: ["#ffc2d1", "#d62f4f"],
  chinese: ["#ffe08a", "#c62828"],
  thai: ["#c9f2c7", "#2e8b57"],
  vietnamese: ["#e3f6c8", "#3f8f3f"],
  malaysian: ["#ffe3a3", "#c56a12"],
  singaporean: ["#fff0c2", "#d17b0f"],
  indonesian: ["#ffd29a", "#a63d10"],
  international: ["#cfe8f3", "#2f6f8f"],
};

export function DishArt({ dish, compact = false, label = true }: { dish: Dish; compact?: boolean; label?: boolean }) {
  const [from, to] = PALETTES[dish.cuisine] ?? ["#eee", "#999"];
  const [failed, setFailed] = useState(false);
  if (dish.photo && !failed) {
    return (
      <div className="relative h-full w-full overflow-hidden bg-surface-2" aria-hidden="true" data-testid="dish-art" data-photo="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- static export: plain, pre-sized files */}
        <img
          src={`${BASE}/${dish.photo.file}`}
          alt=""
          loading={compact ? "lazy" : "eager"}
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
        {label && !compact && (
          <>
            <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/35 to-transparent" />
            <span className="absolute left-3 top-3 max-w-[85%] truncate rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm" data-testid="photo-credit">
              {photoCredit(dish)}
            </span>
          </>
        )}
      </div>
    );
  }
  return (
    <div
      className="relative h-full w-full overflow-hidden"
      style={{ background: `radial-gradient(120% 90% at 30% 20%, ${from} 0%, ${to} 100%)` }}
      aria-hidden="true"
      data-testid="dish-art"
    >
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.9) 1.2px, transparent 0)",
          backgroundSize: compact ? "10px 10px" : "18px 18px",
        }}
      />
      <div className="absolute inset-0 grid place-items-center">
        <span
          className="select-none drop-shadow-[0_10px_18px_rgba(0,0,0,0.25)]"
          style={{ fontSize: compact ? "2.4rem" : "clamp(5rem, 28vw, 8.5rem)", lineHeight: 1 }}
        >
          {dish.illustration}
        </span>
      </div>
      {label && !compact && (
        <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
          Illustration · no photo yet
        </span>
      )}
    </div>
  );
}
