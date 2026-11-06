"use client";

import { useEffect, useState } from "react";
import {
  accountStatus,
  addEmail,
  cancelPendingEmail,
  confirmAddEmail,
  confirmSignIn,
  deleteCloudAccount,
  onAccountStatus,
  requestSignInCode,
  signOutHere,
  startCloudSync,
  syncNow,
  turnOnAsGuest,
  type AccountStatus,
} from "@/lib/cloud-sync";
import { Sheet } from "./Sheet";

const btn = "rounded-full px-4 py-2 text-sm font-semibold";

/** What is and isn't stored — shown before consent (R-025) and kept visible afterwards. */
function WhatWeStore() {
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
      <li>
        <strong className="text-ink">Saved to your account:</strong> meals you log (and corrections), your swipe sessions and picks, ratings, and your variety
        setting.
      </li>
      <li>
        <strong className="text-ink">Never sent:</strong> your dietary restrictions — they stay on this phone.
      </li>
      <li>Stored with Supabase (database in Singapore). Only you can read it; there are no shared or public views.</li>
      <li>You can stop and delete everything here at any time.</li>
    </ul>
  );
}

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "not yet";
}

/** "Your account" — M2 cloud food memory (ENG-022, ENG-024, ENG-027). */
export function CloudAccount() {
  const [s, setS] = useState<AccountStatus>({ kind: "unavailable" });
  const [consentOpen, setConsentOpen] = useState(false);
  const [mode, setMode] = useState<"idle" | "add-email" | "sign-in">("idle");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    startCloudSync();
    const refresh = () => setS(accountStatus());
    refresh();
    return onAccountStatus(refresh);
  }, []);

  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: "ok", text: ok });
    } catch (e) {
      setMsg({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      setS(accountStatus());
    }
  };

  if (s.kind === "unavailable") return null;

  return (
    <section className="mt-8 rounded-3xl bg-surface p-4 ring-1 ring-line" aria-labelledby="account" data-testid="cloud-account">
      <h2 id="account" className="text-lg font-semibold">
        Your account
      </h2>

      {msg && (
        <p role="status" className={`mt-3 rounded-2xl px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-surface-2" : "bg-warn-bg text-warn-ink"}`}>
          {msg.text}
        </p>
      )}

      {s.kind === "off" && mode !== "sign-in" && (
        <>
          <p className="mt-1 text-sm text-muted">Keep your food history safe and use it on other devices. Off until you turn it on.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={`${btn} bg-accent text-accent-ink`} onClick={() => setConsentOpen(true)} disabled={busy}>
              Save my food history
            </button>
            <button type="button" className={`${btn} ring-1 ring-line`} onClick={() => setMode("sign-in")} disabled={busy}>
              I already have an account
            </button>
          </div>
        </>
      )}

      {s.kind === "on" && (
        <div className="mt-1 text-sm" data-testid="account-on">
          <p>
            {s.guest ? (
              <>
                Saving as a <strong>guest on this phone</strong>. Add your email so you can sign in elsewhere and never lose it.
              </>
            ) : (
              <>
                Signed in as <strong>{s.email}</strong>.
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-muted" data-testid="sync-status">
            {s.syncing ? "Syncing…" : s.error ? s.error : `Last synced: ${when(s.lastSyncedAt)}`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={`${btn} ring-1 ring-line`} onClick={() => run(syncNow)} disabled={busy || s.syncing}>
              Sync now
            </button>
            {s.guest && mode !== "add-email" && (
              <button type="button" className={`${btn} bg-accent text-accent-ink`} onClick={() => setMode("add-email")}>
                Add email
              </button>
            )}
            {!s.guest && (
              <button type="button" className={`${btn} ring-1 ring-line`} onClick={() => run(signOutHere, "Signed out on this phone. Your cloud copy is kept.")} disabled={busy}>
                Sign out on this phone
              </button>
            )}
          </div>
        </div>
      )}

      {(mode === "add-email" || mode === "sign-in") && (
        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!codeSent) {
              void run(
                () => (mode === "add-email" ? addEmail(email) : requestSignInCode(email)).then(() => setCodeSent(true)),
                "We emailed you a 6-digit code.",
              );
            } else {
              void run(
                async () => {
                  await (mode === "add-email" ? confirmAddEmail(code) : confirmSignIn(code));
                  setMode("idle");
                  setCode("");
                  setCodeSent(false);
                },
                mode === "add-email" ? "Email added. You can now sign in on other devices." : "Signed in. Your history is syncing.",
              );
            }
          }}
        >
          <label className="block text-sm font-semibold" htmlFor="acct-email">
            {mode === "add-email" ? "Your email" : "Sign in with your email"}
          </label>
          {mode === "sign-in" && <p className="text-xs text-muted">Meals already on this phone are merged into your account.</p>}
          <input
            id="acct-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={codeSent}
            className="h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px]"
          />
          {(codeSent) && (
            <>
              <label className="block text-sm font-semibold" htmlFor="acct-code">
                6-digit code from the email
              </label>
              <input
                id="acct-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6,10}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-11 w-full rounded-2xl bg-surface-2 px-3 text-[16px] tracking-widest"
              />
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" className={`${btn} bg-accent text-accent-ink`} disabled={busy}>
              {codeSent ? "Confirm code" : "Email me a code"}
            </button>
            <button
              type="button"
              className={`${btn} text-muted`}
              onClick={() => {
                cancelPendingEmail();
                setCodeSent(false);
                setCode("");
                setMode("idle");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {s.kind === "on" && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium">What&apos;s stored · delete</summary>
          <WhatWeStore />
          <button
            type="button"
            className={`${btn} mt-3 bg-no text-white`}
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Delete your cloud account and everything saved in it? This can't be undone. Data on this phone is kept.")) return;
              void run(deleteCloudAccount, "Your cloud account and its data were deleted. This phone still has its own copy.");
            }}
          >
            Stop &amp; delete my cloud data
          </button>
        </details>
      )}

      <Sheet open={consentOpen} onClose={() => setConsentOpen(false)} title="Save your food history?">
        <div data-testid="consent-sheet">
          <WhatWeStore />
          <p className="mt-3 text-sm text-muted">You start as a guest on this phone — no email needed. Add one later to sign in on other devices.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={`${btn} bg-accent text-accent-ink`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await turnOnAsGuest();
                  setConsentOpen(false);
                }, "Cloud saving is on.")
              }
            >
              I agree — turn it on
            </button>
            <button type="button" className={`${btn} ring-1 ring-line`} onClick={() => setConsentOpen(false)}>
              Not now
            </button>
          </div>
        </div>
      </Sheet>
    </section>
  );
}
