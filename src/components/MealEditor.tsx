"use client";

import { useMemo, useState } from "react";
import { loadCatalog } from "@/catalog";
import type { ConfirmedMeal } from "@/engine";
import { updateMeal } from "@/lib/local-store";
import { Sheet } from "./Sheet";

const catalog = loadCatalog();

/** "2026-11-07T19:30" in local time for <input type="datetime-local">. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Correct a logged meal: what it actually was, and when (R-015, ENG-025). */
export function MealEditor({ meal, onClose, onSaved }: { meal: ConfirmedMeal | null; onClose: () => void; onSaved: () => void }) {
  return (
    <Sheet open={meal !== null} onClose={onClose} title="Correct this meal">
      {meal && <Editor key={meal.id} meal={meal} onClose={onClose} onSaved={onSaved} />}
    </Sheet>
  );
}

function Editor({ meal, onClose, onSaved }: { meal: ConfirmedMeal; onClose: () => void; onSaved: () => void }) {
  const current = meal.dishId ? (catalog.byId.get(meal.dishId)?.name ?? meal.dishId) : (meal.unrecognizedName ?? "");
  const [q, setQ] = useState(current);
  const [dishId, setDishId] = useState<string | null>(meal.dishId);
  const [at, setAt] = useState(toLocalInput(meal.consumedAt));
  const [error, setError] = useState<string | null>(null);

  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || (dishId && catalog.byId.get(dishId)?.name.toLowerCase() === t)) return [];
    return catalog.dishes.filter((d) => d.name.toLowerCase().includes(t)).slice(0, 5);
  }, [q, dishId]);

  const save = () => {
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return setError("Pick a date and time.");
    if (when.getTime() > Date.now() + 60_000) return setError("That time is in the future.");
    const name = q.trim();
    if (!dishId && name.length < 2) return setError("Type what you ate.");
    const timeChanged = toLocalInput(meal.consumedAt) !== at;
    updateMeal(meal.id, {
      dishId,
      unrecognizedName: dishId ? null : name.slice(0, 80),
      consumedAt: timeChanged ? when.toISOString() : meal.consumedAt,
      timeApprox: timeChanged ? false : meal.timeApprox,
    });
    onSaved();
  };

  return (
    <div className="space-y-3" data-testid="meal-editor">
      <div>
        <label htmlFor="meal-what" className="text-sm font-semibold">
          What did you eat?
        </label>
        <input
          id="meal-what"
          value={q}
          autoComplete="off"
          onChange={(e) => {
            setQ(e.target.value);
            setDishId(null);
          }}
          className="mt-1 h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px]"
        />
        <ul className="mt-1 space-y-1">
          {matches.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="w-full rounded-xl px-2 py-1.5 text-left text-sm font-medium hover:bg-surface-2"
                onClick={() => {
                  setDishId(d.id);
                  setQ(d.name);
                }}
              >
                {d.illustration} {d.name}
              </button>
            </li>
          ))}
        </ul>
        {!dishId && q.trim().length >= 2 && <p className="mt-1 text-xs text-muted">Not in our dish list — saved as typed, but it can&apos;t shape suggestions.</p>}
      </div>
      <div>
        <label htmlFor="meal-when" className="text-sm font-semibold">
          When?
        </label>
        <input id="meal-when" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="mt-1 h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px]" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-no">
          {error}
        </p>
      )}
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={save} className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink">
          Save correction
        </button>
        <button type="button" onClick={onClose} className="rounded-full px-4 py-2.5 text-sm font-semibold text-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}
