"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { loadCatalog } from "@/catalog";
import type { ConfirmedMeal } from "@/engine";
import { encodeBackup, parseBackup } from "@/lib/backup-format";
import {
  cloudStatus,
  connect,
  disconnect,
  keepLocalAndOverwrite,
  onCloudStatus,
  restoreFromCloud,
  saveNow,
  startCloudBackup,
  type CloudStatus,
} from "@/lib/cloud-backup";
import { RESTRICTION_LABELS } from "./DishInfo";
import type { RestrictionKey } from "@/engine";
import { clearAllLocalData, getProfile, getRestrictions, listMeals, removeMeal, replaceAll, setProfile, setRestrictions, snapshot } from "@/lib/local-store";
import { relativeWhen } from "@/lib/recent-meals";

const catalog = loadCatalog();

const VARIETY = [
  { value: 0.5, label: "I like routine", hint: "Repeats are fine — recent meals matter less." },
  { value: 1, label: "Normal", hint: "Balance favourites and variety." },
  { value: 1.5, label: "I get bored quickly", hint: "Push harder for something different." },
];

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/** "Your data": taste profile, meal history, GitHub backup (padel-os style), backup file, reset. */
export function DataPanel() {
  const [status, setStatus] = useState<CloudStatus>({ on: false });
  const [meals, setMeals] = useState<ConfirmedMeal[]>([]);
  const [variety, setVariety] = useState(1);
  const [restrictions, setRestrictionState] = useState<RestrictionKey[]>([]);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setStatus(cloudStatus());
    setMeals(listMeals().sort((a, b) => b.consumedAt.localeCompare(a.consumedAt)));
    setVariety(getProfile().varietySeeking);
    setRestrictionState(getRestrictions());
  };
  useEffect(() => {
    startCloudBackup();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    return onCloudStatus(refresh);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const nameOf = (m: ConfirmedMeal) => (m.dishId ? catalog.byId.get(m.dishId)?.name : m.unrecognizedName) ?? "Meal";

  return (
    <div className="mx-auto max-w-xl px-4 pb-16 pt-4">
      <Link href="/" className="inline-block py-2 text-sm font-medium text-muted">
        ← Back
      </Link>
      <h1 className="mt-1 font-display text-[2.2rem] font-semibold">Your data</h1>
      <p className="mt-1 text-sm text-muted">Everything is stored on this phone. Optionally, a copy is backed up to a private GitHub repository you own.</p>

      {message && (
        <p role="status" className={`mt-4 rounded-2xl px-4 py-3 text-sm ${message.kind === "ok" ? "bg-surface-2" : "bg-warn-bg text-warn-ink"}`}>
          {message.text}
        </p>
      )}

      <section className="mt-6" aria-labelledby="taste">
        <h2 id="taste" className="text-lg font-semibold">
          How much variety do you like?
        </h2>
        <p className="text-sm text-muted">Controls how strongly recent meals steer suggestions away from repeats.</p>
        <div className="mt-3 grid gap-2" role="radiogroup" aria-labelledby="taste">
          {VARIETY.map((v) => (
            <label key={v.value} className="flex cursor-pointer items-start gap-3 rounded-2xl bg-surface p-3 ring-1 ring-line">
              <input
                type="radio"
                name="variety"
                className="mt-1 h-4 w-4"
                checked={variety === v.value}
                onChange={() => {
                  setProfile({ varietySeeking: v.value });
                  setVariety(v.value);
                }}
              />
              <span>
                <span className="font-medium">{v.label}</span>
                <span className="block text-xs text-muted">{v.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="mt-8" aria-labelledby="restr" data-testid="restrictions-summary">
        <h2 id="restr" className="text-lg font-semibold">
          Dietary restrictions
        </h2>
        <p className="text-sm text-muted">
          {restrictions.length === 0
            ? "None set. You can add them from the home screen."
            : `Avoiding: ${restrictions.map((k) => (RESTRICTION_LABELS[k].split(" (")[0] ?? k).toLowerCase()).join(", ")}.`}{" "}
          Remembered on this phone only — never backed up or exported.
        </p>
        {restrictions.length > 0 && (
          <button
            type="button"
            className="mt-2 rounded-full bg-surface px-4 py-2 text-sm font-semibold ring-1 ring-line"
            onClick={() => {
              setRestrictions([]);
              refresh();
            }}
          >
            Forget restrictions on this phone
          </button>
        )}
      </section>

      <section className="mt-8" aria-labelledby="meals">
        <h2 id="meals" className="text-lg font-semibold">
          Meals you&apos;ve logged ({meals.length})
        </h2>
        {meals.length === 0 && <p className="mt-1 text-sm text-muted">None yet. Add recent meals when you start discovering.</p>}
        <ul className="mt-2 space-y-1.5">
          {meals.slice(0, 40).map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface px-3 py-2 text-sm ring-1 ring-line">
              <span className="min-w-0">
                <span className="block truncate font-medium">{nameOf(m)}</span>
                <span className="text-xs text-muted">
                  {relativeWhen(m.consumedAt, new Date(), m.timeApprox)} · {new Date(m.consumedAt).toLocaleDateString()}
                </span>
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-no"
                onClick={() => {
                  removeMeal(m.id);
                  refresh();
                }}
                aria-label={`Remove ${nameOf(m)}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8 rounded-3xl bg-surface p-4 ring-1 ring-line" aria-labelledby="cloud" data-testid="cloud-backup">
        <h2 id="cloud" className="text-lg font-semibold">
          Backup to GitHub
        </h2>
        {!status.on ? (
          <>
            <p className="mt-1 text-sm text-muted">
              Like padel-os: after changes, your data is saved as one file in a <strong>private</strong> repository you own. GitHub keeps every
              version. Saves happen while the app is open.
            </p>
            <details className="mt-3 rounded-2xl bg-surface-2 p-3 text-sm">
              <summary className="cursor-pointer font-semibold">One-time setup (about 2 minutes)</summary>
              <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>
                  On github.com create a new <strong>private</strong> repository, e.g. <code>food-discovery-data</code>.
                </li>
                <li>
                  Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong> → Generate new token.
                </li>
                <li>
                  Repository access: <strong>Only select repositories</strong> → that data repository. Permissions → Contents:{" "}
                  <strong>Read and write</strong>.
                </li>
                <li>Copy the token and paste it below. It stays on this phone and is never included in backups.</li>
              </ol>
            </details>
            <label className="mt-3 block text-sm font-medium" htmlFor="gh-repo">
              Repository
            </label>
            <input
              id="gh-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="your-username/food-discovery-data"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1 h-11 w-full rounded-xl bg-surface-2 px-3 text-[16px]"
            />
            <label className="mt-3 block text-sm font-medium" htmlFor="gh-token">
              Access token
            </label>
            <input
              id="gh-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              className="mt-1 h-11 w-full rounded-xl bg-surface-2 px-3 text-[16px]"
            />
            <button
              type="button"
              disabled={busy}
              className="mt-3 h-11 w-full rounded-full bg-accent font-semibold text-accent-ink disabled:opacity-50"
              onClick={() =>
                run(async () => {
                  const r = await connect({ token, repo });
                  if (r.ok) {
                    setToken("");
                    setMessage({ kind: "ok", text: "Backup connected." });
                  } else setMessage({ kind: "error", text: r.error });
                })
              }
            >
              {busy ? "Connecting…" : "Connect backup"}
            </button>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm">
              Backing up to <code>{status.repo}</code>
            </p>
            {status.awaitingChoice ? (
              <div className="mt-3 rounded-2xl bg-warn-bg p-3 text-sm text-warn-ink">
                <p>A backup from {when(status.awaitingChoice.savedAt)} already exists. Which data should we keep?</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" disabled={busy} className="rounded-full bg-accent px-4 py-2 font-semibold text-accent-ink" onClick={() => run(async () => void (await restoreFromCloud()))}>
                    Restore the backup
                  </button>
                  <button type="button" disabled={busy} className="rounded-full bg-surface px-4 py-2 font-semibold" onClick={() => run(keepLocalAndOverwrite)}>
                    Keep this phone&apos;s data
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm text-muted" data-testid="cloud-status">
                {status.saving ? "Saving…" : status.waiting ? "Changes waiting to be saved." : `Last saved: ${when(status.lastOk)}`}
              </p>
            )}
            {status.error && <p className="mt-2 rounded-xl bg-warn-bg px-3 py-2 text-sm text-warn-ink">{status.error}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={busy} className="rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold" onClick={() => run(saveNow)}>
                Back up now
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded-full bg-surface-2 px-4 py-2 text-sm font-semibold"
                onClick={() => {
                  if (!window.confirm("Replace the data on this phone with the GitHub backup?")) return;
                  void run(async () => {
                    const r = await restoreFromCloud();
                    setMessage(r.ok ? { kind: "ok", text: `Restored the backup from ${when(r.savedAt)}.` } : { kind: "error", text: r.error });
                  });
                }}
              >
                Restore from GitHub
              </button>
              <button
                type="button"
                className="rounded-full px-4 py-2 text-sm font-semibold text-no"
                onClick={() => {
                  if (!window.confirm("Stop backing up and forget the token on this phone? Your GitHub copy is kept.")) return;
                  disconnect();
                  refresh();
                }}
              >
                Disconnect
              </button>
            </div>
          </>
        )}
      </section>

      <section className="mt-8" aria-labelledby="file">
        <h2 id="file" className="text-lg font-semibold">
          Backup file
        </h2>
        <p className="text-sm text-muted">Save a copy to Files, or restore one — no GitHub needed.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-full bg-surface px-4 py-2 text-sm font-semibold ring-1 ring-line"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([encodeBackup(snapshot(), new Date().toISOString())], { type: "application/json" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = `food-discovery-backup-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download backup file
          </button>
          <button type="button" className="rounded-full bg-surface px-4 py-2 text-sm font-semibold ring-1 ring-line" onClick={() => fileRef.current?.click()}>
            Restore from file
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const r = parseBackup(await f.text());
              if (!r.ok) return setMessage({ kind: "error", text: r.error });
              if (!window.confirm(`Replace the data on this phone with the backup from ${when(r.file.savedAt)}?`)) return;
              replaceAll(r.file.data);
              if (cloudStatus().on) await saveNow();
              setMessage({ kind: "ok", text: "Backup restored." });
              refresh();
            }}
          />
        </div>
      </section>

      <section className="mt-8" aria-labelledby="reset">
        <h2 id="reset" className="text-lg font-semibold">
          Start fresh
        </h2>
        <button
          type="button"
          className="mt-2 rounded-full bg-no px-4 py-2 text-sm font-semibold text-white"
          onClick={() => {
            if (!window.confirm("Delete all meals, sessions and settings on this phone? The GitHub backup (if any) is disconnected first and kept.")) return;
            disconnect();
            clearAllLocalData();
            refresh();
            setMessage({ kind: "ok", text: "Data on this phone cleared." });
          }}
        >
          Clear all data on this phone
        </button>
      </section>
    </div>
  );
}
