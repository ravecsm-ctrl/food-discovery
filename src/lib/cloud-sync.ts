/**
 * Cloud food memory with Supabase (M2: ENG-022 identity, ENG-023 sessions, ENG-024 preferences,
 * ENG-025/026 meals and corrections, ENG-027 consent and deletion).
 *
 * - Off until the person opts in and consents (R-025). Before that, nothing leaves the phone.
 * - Identity: a guest (Supabase anonymous user) first; adding an email keeps the same account and
 *   data (R-020). Sign-in on another device uses a 6-digit email code (works inside the home-screen app).
 * - The phone stays usable offline; changes are reconciled in the background (see sync-plan.ts).
 * - Every write goes through a reviewed database function; the browser can't touch tables (D-12).
 * - Dietary restrictions are never sent. The publishable key is public by design; there are no secrets here.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { applyCloudChanges, getProfile, listEvalSessions, listMeals, onDataChange } from "./local-store";
import { ledgerAfter, planSync, type CloudState, type LocalState, type SyncLedger } from "./sync-plan";

export const PRIVACY_POLICY_VERSION = "privacy-v1";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY_ = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const STATE_KEY = "fd.account.v1";
const AUTH_KEY = "fd.auth.v1";
const WAIT_MS = 4000;

export function cloudConfigured(): boolean {
  const hosted = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(URL_);
  const local = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(URL_);
  return (hosted || local) && KEY_.length > 20;
}

interface Persisted {
  enabled: boolean;
  ledger: SyncLedger | null;
}

export type AccountStatus =
  | { kind: "unavailable" }
  | { kind: "off" }
  | {
      kind: "on";
      userId: string;
      email: string | null;
      guest: boolean;
      syncing: boolean;
      lastSyncedAt: string | null;
      error: string | null;
      pendingEmail: string | null;
    };

let client: SupabaseClient | null = null;
let persisted: Persisted = { enabled: false, ledger: null };
let identity: { userId: string; email: string | null; guest: boolean } | null = null;
let syncing = false;
let again = false;
let lastError: string | null = null;
let pendingEmail: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
const listeners = new Set<() => void>();

function sb(): SupabaseClient {
  if (!client) {
    client = createClient(URL_, KEY_, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_KEY },
    });
  }
  return client;
}

function load() {
  try {
    const raw = window.localStorage.getItem(STATE_KEY);
    persisted = raw ? { enabled: false, ledger: null, ...(JSON.parse(raw) as Partial<Persisted>) } : { enabled: false, ledger: null };
  } catch {
    persisted = { enabled: false, ledger: null };
  }
}
function save() {
  try {
    window.localStorage.setItem(STATE_KEY, JSON.stringify(persisted));
  } catch {
    /* ignore */
  }
  notify();
}
function notify() {
  listeners.forEach((fn) => fn());
}

export function onAccountStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function accountStatus(): AccountStatus {
  if (!cloudConfigured()) return { kind: "unavailable" };
  if (!persisted.enabled || !identity) return { kind: "off" };
  return {
    kind: "on",
    ...identity,
    syncing,
    lastSyncedAt: persisted.ledger?.userId === identity.userId ? (persisted.ledger.lastSyncedAt ?? null) : null,
    error: lastError,
    pendingEmail,
  };
}

/** Human-readable error from a Supabase/RPC failure (ETD §6.1 codes). */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  if (/CONSENT_REQUIRED/.test(msg)) return "Cloud saving was turned off for this account.";
  if (/SESSION_VERSION_CONFLICT/.test(msg)) return "Another device changed this data at the same time. Trying again will fix it.";
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return "You're offline. Your data is safe on this phone and will sync when you're back online.";
  if (/rate limit|too many/i.test(msg)) return "Too many attempts. Please wait a few minutes and try again.";
  if (/(otp|token).*(expired|invalid)|invalid.*(otp|token)/i.test(msg)) return "That code didn't work or has expired. Request a new one.";
  return msg.replace(/^[A-Z_]+: /, "");
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  // One automatic retry with the SAME arguments (same request id) is safe: the server deduplicates.
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await sb().rpc(fn, args);
    if (!error) return data as T;
    const transient = !error.code || /fetch|network|timeout/i.test(error.message);
    if (!transient || attempt >= 1) throw new Error(error.message);
  }
}

const rid = () => crypto.randomUUID();

async function refreshIdentity() {
  const { data } = await sb().auth.getSession();
  const u = data.session?.user;
  identity = u ? { userId: u.id, email: u.email ?? null, guest: u.is_anonymous ?? !u.email } : null;
}

/** Called once from app shells. Restores the session and keeps the cloud copy in step with the phone. */
export function startCloudSync(): void {
  if (started || typeof window === "undefined" || !cloudConfigured()) return;
  started = true;
  load();
  void refreshIdentity().then(() => {
    notify();
    if (persisted.enabled) void syncNow();
  });
  sb().auth.onAuthStateChange(() => {
    void refreshIdentity().then(notify);
  });
  onDataChange(() => schedule());
  window.addEventListener("online", () => schedule(0));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule(0);
  });
}

function schedule(ms = WAIT_MS) {
  if (!persisted.enabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), ms);
}

function localState(): LocalState {
  return { meals: listMeals(), sessions: listEvalSessions(), varietySeeking: getProfile().varietySeeking };
}

/** Reconcile phone ⇄ cloud once. Safe to call any time; concurrent calls coalesce. */
export async function syncNow(): Promise<void> {
  if (!persisted.enabled || !cloudConfigured()) return;
  if (syncing) {
    again = true;
    return;
  }
  syncing = true;
  lastError = null;
  notify();
  try {
    await refreshIdentity();
    if (!identity) throw new Error("Signed out. Turn cloud saving on again to continue.");
    for (let round = 0; round < 2; round++) {
      const cloud = await rpc<CloudState>("get_my_data");
      if (!cloud.consent) {
        persisted.enabled = false;
        save();
        throw new Error("CONSENT_REQUIRED");
      }
      const base = persisted.ledger?.userId === identity.userId ? persisted.ledger : null;
      const plan = planSync(localState(), cloud, base);
      try {
        for (const m of plan.pushMeals) await rpc("save_meal", { p_request_id: rid(), p_meal: m });
        for (const id of plan.deleteCloudMeals) await rpc("delete_meal", { p_request_id: rid(), p_meal_id: id });
        if (plan.pushVariety !== null) await rpc("save_preferences", { p_variety_seeking: plan.pushVariety });
        // Meals first, so satisfaction events in sessions can attach to them.
        for (const s of plan.pushSessions) await rpc("sync_session", { p_request_id: rid(), p_expected_version: s.expectedVersion, p_session: s.record });
      } catch (e) {
        if (round === 0 && /SESSION_VERSION_CONFLICT/.test(String(e))) continue; // re-read and retry once
        throw e;
      }
      applyCloudChanges({ upsertMeals: plan.pullMeals, removeMeals: plan.removeLocalMeals, upsertSessions: plan.pullSessions, varietySeeking: plan.pullVariety });
      persisted.ledger = ledgerAfter(identity.userId, localState(), new Date().toISOString());
      save();
      break;
    }
  } catch (e) {
    lastError = friendlyError(e);
  } finally {
    syncing = false;
    notify();
    if (again) {
      again = false;
      schedule(500);
    }
  }
}

/* ------------------------------------------------------------------ opt-in, identity, deletion */

/** Opt in: start as a guest on this phone, record consent, upload what's on the phone. */
export async function turnOnAsGuest(): Promise<void> {
  load();
  const { data } = await sb().auth.getSession();
  if (!data.session) {
    const { error } = await sb().auth.signInAnonymously();
    if (error) throw new Error(friendlyError(error));
  }
  await rpc("accept_cloud_consent", { p_policy_version: PRIVACY_POLICY_VERSION });
  await refreshIdentity();
  persisted = { enabled: true, ledger: null };
  save();
  await syncNow();
}

/** Guest → permanent account: same user id, so all cloud data stays (R-020, AT-019). Sends a code. */
export async function addEmail(email: string): Promise<void> {
  const { error } = await sb().auth.updateUser({ email: email.trim() });
  if (error) throw new Error(friendlyError(error));
  pendingEmail = email.trim();
  notify();
}

export async function confirmAddEmail(code: string): Promise<void> {
  if (!pendingEmail) throw new Error("Request a code first.");
  const { error } = await sb().auth.verifyOtp({ email: pendingEmail, token: code.trim(), type: "email_change" });
  if (error) throw new Error(friendlyError(error));
  pendingEmail = null;
  await refreshIdentity();
  notify();
}

/** Sign in on this phone to an existing account (sends a 6-digit code; never creates an account). */
export async function requestSignInCode(email: string): Promise<void> {
  const { error } = await sb().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
  if (error) throw new Error(friendlyError(error));
  pendingEmail = email.trim();
  notify();
}

/**
 * Finish sign-in. If this phone was saving as a guest, that guest's cloud copy is deleted first —
 * its data is still on the phone and is merged into the account on the next sync, so nothing is
 * stranded on the server under an identity nobody can reach again.
 */
export async function confirmSignIn(code: string): Promise<void> {
  if (!pendingEmail) throw new Error("Request a code first.");
  const verifier = createClient(URL_, KEY_, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await verifier.auth.verifyOtp({ email: pendingEmail, token: code.trim(), type: "email" });
  if (error || !data.session) throw new Error(friendlyError(error ?? "Sign-in failed."));
  await refreshIdentity();
  if (identity && identity.guest && identity.userId !== data.session.user.id && persisted.enabled) {
    await rpc("delete_my_account");
  }
  const { error: setErr } = await sb().auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  if (setErr) throw new Error(friendlyError(setErr));
  await rpc("accept_cloud_consent", { p_policy_version: PRIVACY_POLICY_VERSION });
  pendingEmail = null;
  await refreshIdentity();
  persisted = { enabled: true, ledger: null };
  save();
  await syncNow();
}

export function cancelPendingEmail(): void {
  pendingEmail = null;
  notify();
}

/** Stop syncing on this phone but keep the cloud copy (only offered for email accounts). */
export async function signOutHere(): Promise<void> {
  await sb().auth.signOut({ scope: "local" });
  identity = null;
  persisted = { enabled: false, ledger: null };
  save();
}

/** Delete the cloud account and everything in it (R-024, AT-031). Data on this phone is kept. */
export async function deleteCloudAccount(): Promise<void> {
  await rpc("delete_my_account");
  await sb().auth.signOut({ scope: "local" });
  identity = null;
  persisted = { enabled: false, ledger: null };
  save();
}

/**
 * Before wiping this phone: a guest's cloud copy would become unreachable, so it is deleted too;
 * an email account keeps its cloud copy and this phone simply signs out.
 */
export async function detachBeforeLocalWipe(): Promise<"none" | "deleted_guest" | "signed_out"> {
  if (!cloudConfigured()) return "none";
  load();
  await refreshIdentity();
  if (!identity) return "none";
  if (identity.guest) {
    await deleteCloudAccount();
    return "deleted_guest";
  }
  await signOutHere();
  return "signed_out";
}
