"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadCatalog } from "@/catalog";
import { POLICIES, POLICY_IDS, type ConfirmedMeal } from "@/engine";
import { summarize, toCsv } from "@/lib/evaluation";
import {
  addMeal,
  clearAllLocalData,
  getAssignmentSetting,
  listEvalSessions,
  listMeals,
  removeMeal,
  setAssignmentSetting,
  type EvalSessionRecord,
} from "@/lib/local-store";

const catalog = loadCatalog();

function download(name: string, mime: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const fmt = (x: number | null, digits = 2) => (x === null ? "—" : x.toFixed(digits));
const ratio = (n: number, d: number) => `${n}/${d}`;

/**
 * Prototype evaluation tool (ENG-018, R-014, R-031). Clearly an internal testing screen.
 * Reads/writes only this browser's local storage; exports are generated in the browser.
 */
export function LabPanel() {
  const [records, setRecords] = useState<EvalSessionRecord[]>([]);
  const [meals, setMeals] = useState<ConfirmedMeal[]>([]);
  const [assignment, setAssignment] = useState("rotation");
  const [mealDish, setMealDish] = useState(catalog.dishes[0]?.id ?? "");
  const [hoursAgo, setHoursAgo] = useState(12);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = () => {
    setRecords(listEvalSessions().sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    setMeals(listMeals().sort((a, b) => b.consumedAt.localeCompare(a.consumedAt)));
    setAssignment(getAssignmentSetting());
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(refresh, []);

  const summary = summarize(records);
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "");

  return (
    <div className="mx-auto max-w-3xl px-4 pb-16 pt-4">
      <div className="mb-5 rounded-2xl border-2 border-dashed border-accent/60 bg-surface p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-accent">Prototype evaluation · internal testing tool</p>
        <h1 className="mt-1 font-display text-3xl font-semibold">Lab</h1>
        <p className="mt-1 text-sm text-muted">
          Compares the fixed baseline with the adaptive policies. All data lives only in this browser. Not for end users. Small-sample numbers are
          directional only and prove nothing statistically.
        </p>
        <Link href="/" className="mt-3 inline-block text-sm font-semibold underline underline-offset-2">
          ← Back to app
        </Link>
      </div>

      <section className="mb-8" aria-labelledby="assign">
        <h2 id="assign" className="mb-2 text-lg font-semibold">
          Policy assignment for new sessions
        </h2>
        <div className="grid gap-2">
          {["rotation", ...POLICY_IDS].map((id) => (
            <label key={id} className="flex cursor-pointer items-start gap-3 rounded-2xl bg-surface p-3 ring-1 ring-line">
              <input
                type="radio"
                name="assignment"
                value={id}
                checked={assignment === id}
                onChange={() => {
                  setAssignmentSetting(id);
                  setAssignment(id);
                }}
                className="mt-1 h-4 w-4"
              />
              <span>
                <span className="font-medium">{id === "rotation" ? "Rotate through all policies (default)" : POLICIES[id]?.label}</span>
                <span className="block text-xs text-muted">
                  {id === "rotation" ? "Sessions cycle through baseline-fixed-v0 → adaptive-v1 → adaptive-exposure-v1, so arms receive similar counts." : `${id} · PRRD arm ${POLICIES[id]?.experimentArm}`}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="mb-8" aria-labelledby="summary">
        <h2 id="summary" className="mb-2 text-lg font-semibold">
          Comparison by policy
        </h2>
        <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
          <table className="w-full min-w-[640px] bg-surface text-left text-sm" data-testid="summary-table">
            <thead className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="p-3">Policy</th>
                <th className="p-3">Sessions</th>
                <th className="p-3">Reached results</th>
                <th className="p-3">Selected a dish</th>
                <th className="p-3">Median cards to 1st results</th>
                <th className="p-3">Yes rate</th>
                <th className="p-3">Meals confirmed (match pick)</th>
                <th className="p-3">Rated · mean</th>
                <th className="p-3">No-match runs</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.policyId} className="border-t border-line">
                  <td className="p-3 font-mono text-xs">{s.policyId}</td>
                  <td className="p-3">{s.sessions}</td>
                  <td className="p-3">{ratio(s.sessionsWithResults, s.sessions)}</td>
                  <td className="p-3">{ratio(s.sessionsWithSelection, s.sessionsWithResults)}</td>
                  <td className="p-3">{fmt(s.medianCardsToFirstResults, 1)}</td>
                  <td className="p-3">{fmt(s.yesRate)}</td>
                  <td className="p-3">
                    {s.mealsConfirmed} ({s.mealsMatchingSelection})
                  </td>
                  <td className="p-3">
                    {s.ratings} · {fmt(s.meanRating, 1)}
                  </td>
                  <td className="p-3">{ratio(s.noMatchRuns, s.totalRuns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">Missing ratings are not treated as negative; they are simply absent (rated count shown).</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-accent-ink"
            onClick={() => download(`food-eval-${stamp}.json`, "application/json", JSON.stringify({ exportedAt: new Date().toISOString(), sessions: records, meals }, null, 2))}
          >
            Export JSON
          </button>
          <button type="button" className="rounded-full bg-surface px-4 py-2 text-sm font-semibold ring-1 ring-line" onClick={() => download(`food-eval-${stamp}.csv`, "text/csv", toCsv(records))}>
            Export CSV (one row per card)
          </button>
        </div>
      </section>

      <section className="mb-8" aria-labelledby="sessions">
        <h2 id="sessions" className="mb-2 text-lg font-semibold">
          Sessions ({records.length})
        </h2>
        {records.length === 0 && <p className="text-sm text-muted">No sessions recorded yet.</p>}
        <ul className="space-y-2">
          {records.map((r) => {
            const sel = r.events.find((e) => e.type === "dish_selected");
            return (
              <li key={r.sessionId} className="rounded-2xl bg-surface ring-1 ring-line">
                <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 p-3 text-left text-sm" onClick={() => setOpen(open === r.sessionId ? null : r.sessionId)} aria-expanded={open === r.sessionId}>
                  <span className="font-mono text-xs">{r.policyId}</span>
                  <span>{new Date(r.startedAt).toLocaleString()}</span>
                  <span>{r.exposures.filter((e) => e.reaction).length} cards</span>
                  <span>{sel?.type === "dish_selected" ? `picked ${catalog.byId.get(sel.dishId)?.name}` : "no pick"}</span>
                </button>
                {open === r.sessionId && <pre className="max-h-96 overflow-auto border-t border-line p-3 text-[11px] leading-snug">{JSON.stringify(r, null, 2)}</pre>}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mb-8" aria-labelledby="meals">
        <h2 id="meals" className="mb-2 text-lg font-semibold">
          Confirmed meals on this device ({meals.length})
        </h2>
        <p className="mb-3 text-sm text-muted">Used by the exposure-aware policy. Synthetic meals are test fixtures and are labelled as such.</p>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addMeal({
              id: `synthetic-${crypto.randomUUID()}`,
              dishId: mealDish,
              consumedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
              confirmed: true,
              source: "synthetic",
            });
            refresh();
          }}
        >
          <label className="text-sm">
            <span className="block text-xs text-muted">Synthetic meal</span>
            <select value={mealDish} onChange={(e) => setMealDish(e.target.value)} className="h-10 rounded-xl bg-surface px-2 ring-1 ring-line">
              {catalog.dishes.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-muted">Hours ago</span>
            <input type="number" min={0} max={240} value={hoursAgo} onChange={(e) => setHoursAgo(Number(e.target.value))} className="h-10 w-24 rounded-xl bg-surface px-2 ring-1 ring-line" />
          </label>
          <button type="submit" className="h-10 rounded-full bg-surface-2 px-4 text-sm font-semibold">
            Add synthetic meal
          </button>
        </form>
        <ul className="space-y-1 text-sm">
          {meals.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 ring-1 ring-line">
              <span>
                {m.dishId ? catalog.byId.get(m.dishId)?.name : `“${m.unrecognizedName}” (not in catalog)`} ·{" "}
                <span className="text-muted">
                  {new Date(m.consumedAt).toLocaleString()} · {m.source}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  removeMeal(m.id);
                  refresh();
                }}
                className="text-xs font-semibold text-no"
                aria-label={`Remove meal record ${m.id}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="danger">
        <h2 id="danger" className="mb-2 text-lg font-semibold">
          Local data
        </h2>
        <button
          type="button"
          className="rounded-full bg-no px-4 py-2 text-sm font-semibold text-white"
          onClick={() => {
            if (window.confirm("Delete all prototype sessions, meals, and settings stored in this browser? This cannot be undone.")) {
              clearAllLocalData();
              refresh();
            }
          }}
        >
          Clear all local prototype data
        </button>
      </section>
    </div>
  );
}
