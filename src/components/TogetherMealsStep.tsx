"use client";

import { useMemo, useState } from "react";
import { loadCatalog } from "@/catalog";
import type { ParticipantNames, TogetherMeal } from "@/engine";
import { WHEN_LABELS, relativeWhen, whenToIso, type WhenChoice } from "@/lib/recent-meals";
import { DishArt } from "./DishArt";

const catalog = loadCatalog();
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tm-${Date.now()}-${Math.round(Math.random() * 1e9)}`);

/**
 * Together Mode opener: "What have you two eaten recently?" (optional). Each meal says who had it, so it
 * only steers that person's side of the joint ranking. Session-only: never saved to anyone's history.
 */
export function TogetherMealsStep(props: { names: ParticipantNames; onContinue: (meals: TogetherMeal[]) => void; onBack: () => void }) {
  const { names } = props;
  const [meals, setMeals] = useState<TogetherMeal[]>([]);
  const [q, setQ] = useState("");
  const [dishId, setDishId] = useState<string | null>(null);
  const [who, setWho] = useState<TogetherMeal["who"] | null>(null);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return catalog.dishes.filter((d) => d.name.toLowerCase().includes(t)).slice(0, 6);
  }, [q]);

  const whoLabel = (w: TogetherMeal["who"]) => (w === "both" ? "Both of you" : names[w]);
  const reset = () => {
    setDishId(null);
    setWho(null);
    setQ("");
  };
  const add = (when: WhenChoice) => {
    if (!dishId || !who) return;
    setMeals((ms) => [...ms, { id: newId(), dishId, consumedAt: whenToIso(when, new Date()), confirmed: true, source: "recall", timeApprox: true, who }]);
    reset();
  };
  const picked = dishId ? catalog.byId.get(dishId) : null;

  return (
    <section className="flex flex-1 flex-col pt-3" aria-labelledby="together-meals-title" data-testid="together-meals">
      <button type="button" onClick={props.onBack} className="self-start rounded-full py-2 text-sm font-medium text-muted">
        ← Back
      </button>
      <h1 id="together-meals-title" className="mt-2 font-display text-[2rem] font-semibold leading-tight">
        What have you two eaten recently?
      </h1>
      <p className="mt-2 text-muted">So tonight&apos;s picks feel fresh for both of you. Optional — used for this session only, not saved.</p>

      {meals.length > 0 && (
        <ul className="mt-5 space-y-2" aria-label="Recent meals for this session">
          {meals.map((m) => {
            const d = m.dishId ? catalog.byId.get(m.dishId) : undefined;
            return (
              <li key={m.id} className="flex items-center gap-3 rounded-2xl bg-surface p-2 pr-3 ring-1 ring-line" data-testid="together-meal">
                <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-2">{d && <DishArt dish={d} compact />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{d?.name}</span>
                  <span className="text-xs text-muted">
                    {whoLabel(m.who)} · {relativeWhen(m.consumedAt, new Date(), true)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setMeals((ms) => ms.filter((x) => x.id !== m.id))}
                  className="grid h-10 w-10 place-items-center rounded-full text-muted"
                  aria-label={`Remove ${d?.name ?? "meal"}`}
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
            <label htmlFor="together-search" className="text-sm font-semibold">
              {meals.length === 0 ? "Add a recent meal" : "Add another meal"}
            </label>
            <input
              id="together-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="e.g. Adobo, ramen, pizza"
              autoComplete="off"
              className="mt-2 h-12 w-full rounded-2xl bg-surface-2 px-4 text-[16px]"
            />
            <ul className="mt-2 space-y-1">
              {matches.map((d) => (
                <li key={d.id}>
                  <button type="button" onClick={() => setDishId(d.id)} className="flex w-full items-center gap-3 rounded-xl p-1.5 text-left">
                    <span className="h-9 w-9 overflow-hidden rounded-lg">
                      <DishArt dish={d} compact />
                    </span>
                    <span className="font-medium">{d.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            {q.trim().length >= 2 && matches.length === 0 && <p className="mt-2 text-xs text-muted">Not in our dish list yet — try a similar dish.</p>}
          </>
        ) : !who ? (
          <div>
            <p className="text-sm font-semibold">Who had {picked.name}?</p>
            <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label="Who had it">
              {(["both", "a", "b"] as const).map((w) => (
                <button key={w} type="button" onClick={() => setWho(w)} className="h-11 truncate rounded-2xl bg-surface-2 px-2 text-sm font-semibold">
                  {w === "both" ? "Both" : names[w]}
                </button>
              ))}
            </div>
            <button type="button" onClick={reset} className="mt-2 text-sm text-muted">
              Cancel
            </button>
          </div>
        ) : (
          <div>
            <p className="text-sm font-semibold">
              When did {who === "both" ? "you both" : names[who]} have {picked.name}?
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2" role="group" aria-label="When">
              {(Object.keys(WHEN_LABELS) as WhenChoice[]).map((w) => (
                <button key={w} type="button" onClick={() => add(w)} className="h-11 rounded-2xl bg-surface-2 text-sm font-semibold">
                  {WHEN_LABELS[w]}
                </button>
              ))}
            </div>
            <button type="button" onClick={reset} className="mt-2 text-sm text-muted">
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="mt-auto space-y-2 pb-2 pt-6">
        <button type="button" onClick={() => props.onContinue(meals)} className="h-14 w-full rounded-full bg-accent text-lg font-semibold text-accent-ink">
          {meals.length > 0 ? "Start swiping" : "Skip — start swiping"}
        </button>
        <p className="text-center text-xs text-muted">Only meals you add here count — we never assume what anyone ate.</p>
      </div>
    </section>
  );
}
