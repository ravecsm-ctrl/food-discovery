"use client";

import { useEffect, useMemo, useState } from "react";
import { loadCatalog } from "@/catalog";
import { searchDishes } from "@/lib/dish-search";
import type { ConfirmedMeal } from "@/engine";
import { addMeal, listMeals, removeMeal } from "@/lib/local-store";
import { WHEN_LABELS, recentMeals, relativeWhen, whenToIso, type WhenChoice } from "@/lib/recent-meals";
import { DishArt } from "./DishArt";

const catalog = loadCatalog();

/**
 * Optional opener: "What have you eaten recently?" (PRRD §5.2/§10.3 — never required).
 * Recalled meals are confirmed consumption reported by the person; they feed taste fatigue.
 * Meals already logged in the last 3 days are shown so you only add what's new.
 */
export function RecentMealsStep({ onContinue, onBack }: { onContinue: () => void; onBack: () => void }) {
  const [meals, setMeals] = useState<ConfirmedMeal[]>([]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ dishId: string | null; name: string } | null>(null);

  const refresh = () => setMeals(recentMeals(listMeals(), new Date()));
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(refresh, []);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 1) return [];
    return searchDishes(catalog, t, 6);
  }, [q]);

  const add = (when: WhenChoice) => {
    if (!picked) return;
    addMeal({
      id: crypto.randomUUID(),
      dishId: picked.dishId,
      unrecognizedName: picked.dishId ? null : picked.name,
      consumedAt: whenToIso(when, new Date()),
      confirmed: true,
      source: "recall",
      timeApprox: true,
    });
    setPicked(null);
    setQ("");
    refresh();
  };

  const nameOf = (m: ConfirmedMeal) => (m.dishId ? catalog.byId.get(m.dishId)?.name : m.unrecognizedName) ?? "Meal";

  return (
    <section className="flex flex-1 flex-col pt-3" aria-labelledby="recent-title" data-testid="recent-meals">
      <button type="button" onClick={onBack} className="self-start rounded-full py-2 text-sm font-medium text-muted">
        ← Back
      </button>
      <h1 id="recent-title" className="mt-2 font-display text-[2rem] font-semibold leading-tight">
        What have you eaten recently?
      </h1>
      <p className="mt-2 text-muted">Your last few meals help us suggest something different. Optional — skip anytime.</p>

      {meals.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="Recent meals">
          {meals.map((m) => {
            const d = m.dishId ? catalog.byId.get(m.dishId) : undefined;
            return (
              <li key={m.id} className="flex items-center gap-3 rounded-2xl bg-surface p-2 pr-3 ring-1 ring-line" data-testid="recent-meal">
                <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-2 text-lg">
                  {d ? <DishArt dish={d} compact /> : <span aria-hidden="true">🍽️</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{nameOf(m)}</span>
                  <span className="text-xs text-muted">{relativeWhen(m.consumedAt, new Date(), m.timeApprox)}</span>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    removeMeal(m.id);
                    refresh();
                  }}
                  className="grid h-10 w-10 place-items-center rounded-full text-muted"
                  aria-label={`Remove ${nameOf(m)}`}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 rounded-3xl bg-surface p-4 ring-1 ring-line">
        {!picked ? (
          <>
            <label htmlFor="recent-search" className="text-sm font-semibold">
              {meals.length === 0 ? "Add your last meal" : "Add another meal"}
            </label>
            <input
              id="recent-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Adobo, ramen, pizza"
              autoComplete="off"
              className="mt-2 h-12 w-full rounded-2xl bg-surface-2 px-4 text-[16px]"
            />
            <ul className="mt-2 space-y-1">
              {matches.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => setPicked({ dishId: d.id, name: d.name })} className="flex w-full items-center gap-3 rounded-xl p-1.5 text-left">
                    <span className="h-9 w-9 overflow-hidden rounded-lg">
                      <DishArt dish={d} compact />
                    </span>
                    <span className="font-medium">{d.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {q.trim().length >= 2 && !matches.some((d) => d.name.toLowerCase() === q.trim().toLowerCase()) && (
              <button type="button" onClick={() => setPicked({ dishId: null, name: q.trim() })} className="mt-2 rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold">
                Use &ldquo;{q.trim()}&rdquo;
              </button>
            )}
          </>
        ) : (
          <div>
            <p className="text-sm font-semibold">When did you have {picked.name}?</p>
            <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="When">
              {(Object.keys(WHEN_LABELS) as WhenChoice[]).map((w) => (
                <button key={w} type="button" onClick={() => add(w)} className="h-11 rounded-2xl bg-surface-2 text-sm font-semibold">
                  {WHEN_LABELS[w]}
                </button>
              ))}
            </div>
            {!picked.dishId && <p className="mt-2 text-xs text-muted">Not in our dish list yet — it&apos;s saved privately and counts as a meal, but can&apos;t shape suggestions.</p>}
            <button type="button" onClick={() => setPicked(null)} className="mt-2 text-sm text-muted">
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto space-y-2 pb-2 pt-6">
        <button type="button" onClick={onContinue} className="h-14 w-full rounded-full bg-accent text-lg font-semibold text-accent-ink">
          {meals.length > 0 ? "Show me ideas" : "Skip — start swiping"}
        </button>
        {meals.length > 0 && <p className="text-center text-xs text-muted">Only meals you tell us about count — we never assume what you ate.</p>}
      </div>
    </section>
  );
}
