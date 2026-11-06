/**
 * Automatic one-way backup to the person's own PRIVATE GitHub repository — the same approach as padel-os.
 * The phone is the place you edit; after changes, the whole backup is saved as one JSON file and
 * GitHub keeps every version. Saves only happen while the app is open (web apps can't run in the
 * background on iPhone). The token is stored only on this device and is never included in backups.
 */
import { checkRepo, encodeBackup, getFile, parseBackup, putFile, validTarget, type Fetch, type GitHubTarget } from "./backup-format";
import { hasLocalData, onDataChange, replaceAll, snapshot } from "./local-store";

const KEY = "fd.cloud.v1";
const WAIT_MS = 8000; // batch a burst of swipes into one save
export const BACKUP_PATH = "food-discovery-backup.json";

export interface CloudState extends GitHubTarget {
  sha: string | null;
  dirty: boolean;
  lastOk: string | null;
  error: string | null;
  /** Remote backup exists and the person hasn't chosen restore vs. overwrite yet. */
  awaitingChoice: { savedAt: string } | null;
}

export const net: { fetch: Fetch } = { fetch: (...a) => globalThis.fetch(...a) };

let state: CloudState | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let saving = false;
let again = false;
const listeners = new Set<() => void>();

function load(): CloudState | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CloudState) : null;
  } catch {
    return null;
  }
}
function persist() {
  try {
    if (state) window.localStorage.setItem(KEY, JSON.stringify(state));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn());
}

export function onCloudStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type CloudStatus =
  | { on: false }
  | { on: true; repo: string; waiting: boolean; lastOk: string | null; error: string | null; awaitingChoice: { savedAt: string } | null; saving: boolean };

export function cloudStatus(): CloudStatus {
  if (!state) return { on: false };
  return { on: true, repo: state.repo, waiting: state.dirty, lastOk: state.lastOk, error: state.error, awaitingChoice: state.awaitingChoice, saving };
}

let started = false;
/** Call once on app start: loads config, listens for changes, flushes anything pending. */
export function startCloudBackup(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  state = load();
  onDataChange(() => {
    if (!state) return;
    state.dirty = true;
    persist();
    schedule();
  });
  window.addEventListener("online", () => schedule(0));
  if (state?.dirty) schedule(0);
}

function schedule(delay = WAIT_MS) {
  if (!state || state.awaitingChoice) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void saveNow(), delay);
}

export async function saveNow(): Promise<void> {
  if (!state || state.awaitingChoice) return;
  if (saving) {
    again = true;
    return;
  }
  saving = true;
  listeners.forEach((fn) => fn());
  try {
    const text = encodeBackup(snapshot(), new Date().toISOString());
    state.sha = await putFile(net.fetch, state, text, state.sha, `Food Discovery backup ${new Date().toISOString().slice(0, 16)}`);
    state.dirty = false;
    state.lastOk = new Date().toISOString();
    state.error = null;
  } catch (e) {
    state.error = e instanceof Error ? e.message : "Backup failed.";
  } finally {
    saving = false;
    persist();
    if (again) {
      again = false;
      schedule(0);
    }
  }
}

/** Connect: validate repo (must be private), then either start backing up or ask restore-vs-overwrite. */
export async function connect(target: Omit<GitHubTarget, "branch" | "path">): Promise<{ ok: true } | { ok: false; error: string }> {
  const t: GitHubTarget = { token: target.token.trim(), repo: target.repo.trim(), branch: "main", path: BACKUP_PATH };
  const invalid = validTarget(t);
  if (invalid) return { ok: false, error: invalid };
  try {
    const { defaultBranch } = await checkRepo(net.fetch, t);
    t.branch = defaultBranch;
    const remote = await getFile(net.fetch, t);
    let awaitingChoice: CloudState["awaitingChoice"] = null;
    if (remote) {
      const parsed = parseBackup(remote.text);
      if (parsed.ok) awaitingChoice = { savedAt: parsed.file.savedAt };
    }
    state = { ...t, sha: remote?.sha ?? null, dirty: true, lastOk: null, error: null, awaitingChoice };
    persist();
    if (!awaitingChoice) await saveNow();
    else if (!hasLocalData()) await restoreFromCloud();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach GitHub." };
  }
}

/** Replace this device's data with the GitHub copy. */
export async function restoreFromCloud(): Promise<{ ok: true; savedAt: string } | { ok: false; error: string }> {
  if (!state) return { ok: false, error: "Backup isn't connected." };
  try {
    const remote = await getFile(net.fetch, state);
    if (!remote) return { ok: false, error: "No backup file found in the repository yet." };
    const parsed = parseBackup(remote.text);
    if (!parsed.ok) return parsed;
    replaceAll(parsed.file.data);
    state.sha = remote.sha;
    state.dirty = false;
    state.awaitingChoice = null;
    state.lastOk = new Date().toISOString();
    state.error = null;
    persist();
    return { ok: true, savedAt: parsed.file.savedAt };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Restore failed." };
  }
}

/** Keep this device's data and overwrite the GitHub copy (GitHub keeps the old version in history). */
export async function keepLocalAndOverwrite(): Promise<void> {
  if (!state) return;
  state.awaitingChoice = null;
  state.dirty = true;
  persist();
  await saveNow();
}

/** Stop backing up and forget the token on this device. The GitHub copy is left untouched. */
export function disconnect(): void {
  if (timer) clearTimeout(timer);
  state = null;
  persist();
}
