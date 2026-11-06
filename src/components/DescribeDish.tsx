"use client";

import { useState } from "react";
import { OWN_DISH_LIMITS, OWN_DISH_OPTIONS, cleanOwnDish, ownDishSummary, type OwnDish } from "@/engine";

type Group = keyof typeof OWN_DISH_OPTIONS;

const TITLES: Record<Group, string> = {
  cuisine: "Cuisine",
  mains: `Main ingredient (up to ${OWN_DISH_LIMITS.mains})`,
  method: "How it's cooked",
  type: "What kind of dish",
  flavors: `Flavours (up to ${OWN_DISH_LIMITS.flavors})`,
};

/**
 * "Describe this dish" — a few taps so a food that isn't in our list still counts toward variety
 * (library step 2). Private to this person; never a safety or ingredient claim.
 */
export function DescribeDish(props: {
  name: string;
  initial?: OwnDish | null;
  saveLabel?: string;
  onSave: (d: OwnDish) => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const [d, setD] = useState<OwnDish>(props.initial ?? { cuisine: null, mains: [], method: null, type: null, flavors: [] });
  const ready = cleanOwnDish(d);

  const isOn = (g: Group, slug: string) => (g === "mains" || g === "flavors" ? d[g].includes(slug) : d[g] === slug);
  const toggle = (g: Group, slug: string) =>
    setD((cur) => {
      if (g === "mains" || g === "flavors") {
        const list = cur[g].includes(slug) ? cur[g].filter((x) => x !== slug) : [...cur[g], slug].slice(-OWN_DISH_LIMITS[g]);
        return { ...cur, [g]: list };
      }
      return { ...cur, [g]: cur[g] === slug ? null : slug };
    });

  return (
    <div data-testid="describe-dish">
      <p className="text-sm text-muted">
        <strong className="text-ink">{props.name}</strong> isn&apos;t in our dish list. Describe it in a few taps so it counts toward variety. Only you see this.
      </p>
      {(Object.keys(OWN_DISH_OPTIONS) as Group[]).map((g) => (
        <fieldset key={g} className="mt-4">
          <legend className="text-sm font-semibold">{TITLES[g]}</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {OWN_DISH_OPTIONS[g].map(([slug, label]) => (
              <button
                key={slug}
                type="button"
                aria-pressed={isOn(g, slug)}
                onClick={() => toggle(g, slug)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${isOn(g, slug) ? "bg-ink text-surface ring-ink" : "bg-surface ring-line"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <p className="mt-4 min-h-5 text-xs text-muted" aria-live="polite">
        {ready ? ownDishSummary(ready) : "Pick at least one thing."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => ready && props.onSave(ready)}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink disabled:opacity-40"
        >
          {props.saveLabel ?? "Save"}
        </button>
        {props.onSkip && (
          <button type="button" onClick={props.onSkip} className="rounded-full px-4 py-2.5 text-sm font-semibold text-muted ring-1 ring-line">
            {props.skipLabel ?? "Skip"}
          </button>
        )}
      </div>
    </div>
  );
}
