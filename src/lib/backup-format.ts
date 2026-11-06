/**
 * Backup file format + a minimal GitHub contents client (pure, testable; no browser storage).
 * The token is never part of a backup file.
 */
import { z } from "zod";
import type { BackupData } from "./local-store";

export const BACKUP_APP = "food-discovery";
export const BACKUP_SCHEMA = 1;

export interface BackupFile {
  app: typeof BACKUP_APP;
  schemaVersion: number;
  savedAt: string;
  data: BackupData;
}

const MealSchema = z
  .object({
    id: z.string(),
    dishId: z.string().nullable(),
    unrecognizedName: z.string().nullable().optional(),
    consumedAt: z.string(),
    confirmed: z.literal(true),
    source: z.enum(["selection_confirmation", "manual", "recall", "synthetic"]),
    timeApprox: z.boolean().optional(),
  })
  .passthrough();

const FileSchema = z.object({
  app: z.literal(BACKUP_APP),
  schemaVersion: z.number().int().min(1).max(BACKUP_SCHEMA),
  savedAt: z.string(),
  data: z.object({
    sessions: z.array(z.object({ sessionId: z.string(), policyId: z.string() }).passthrough()),
    meals: z.array(MealSchema),
    assignment: z.string(),
    profile: z.object({ varietySeeking: z.number().min(0).max(2) }).passthrough(),
  }),
});

export function encodeBackup(data: BackupData, savedAt: string): string {
  const file: BackupFile = { app: BACKUP_APP, schemaVersion: BACKUP_SCHEMA, savedAt, data };
  return JSON.stringify(file, null, 1);
}

export type ParseResult = { ok: true; file: BackupFile } | { ok: false; error: string };

export function parseBackup(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "This isn't a valid backup file (not JSON)." };
  }
  const r = FileSchema.safeParse(json);
  if (!r.success) return { ok: false, error: `This doesn't look like a Food Discovery backup (${r.error.issues[0]?.path.join(".") || "format"}).` };
  return { ok: true, file: r.data as unknown as BackupFile };
}

/* ---------------- base64 for UTF-8 (GitHub contents API) ---------------- */

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------------- GitHub contents client ---------------- */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubTarget {
  token: string;
  /** "owner/name" */
  repo: string;
  branch: string;
  path: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validTarget(t: GitHubTarget): string | null {
  if (!t.token.trim()) return "Paste your access token.";
  if (!REPO_RE.test(t.repo.trim())) return 'Repository must look like "your-username/repo-name".';
  return null;
}

async function call(fetchFn: Fetch, t: GitHubTarget, method: string, path: string, body?: unknown): Promise<Response> {
  return fetchFn(API + path, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${t.token.trim()}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function friendly(status: number, fallback: string): string {
  if (status === 401) return "GitHub rejected the token (expired or mistyped).";
  if (status === 403) return "The token doesn't have permission to write to this repository (needs Contents: Read and write).";
  if (status === 404) return "Repository not found — check the name, and that the token can access it.";
  return fallback;
}

/** Checks the repository exists, is PRIVATE, and is writable with this token. */
export async function checkRepo(fetchFn: Fetch, t: GitHubTarget): Promise<{ defaultBranch: string }> {
  const res = await call(fetchFn, t, "GET", `/repos/${t.repo.trim()}`);
  if (!res.ok) throw new GitHubError(friendly(res.status, `GitHub error ${res.status}.`), res.status);
  const repo = (await res.json()) as { private?: boolean; default_branch?: string; permissions?: { push?: boolean } };
  if (repo.private !== true) throw new GitHubError("That repository is public. Your meal history must go in a PRIVATE repository.", 400);
  if (repo.permissions && repo.permissions.push === false) throw new GitHubError(friendly(403, ""), 403);
  return { defaultBranch: repo.default_branch ?? "main" };
}

export async function getFile(fetchFn: Fetch, t: GitHubTarget): Promise<{ sha: string; text: string } | null> {
  const res = await call(fetchFn, t, "GET", `/repos/${t.repo.trim()}/contents/${encodeURIComponent(t.path)}?ref=${encodeURIComponent(t.branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new GitHubError(friendly(res.status, `GitHub error ${res.status}.`), res.status);
  const j = (await res.json()) as { sha: string; content?: string; encoding?: string };
  return { sha: j.sha, text: j.content ? fromBase64(j.content) : "" };
}

/** Create or update the backup file. Retries once if our known sha is stale. */
export async function putFile(fetchFn: Fetch, t: GitHubTarget, text: string, sha: string | null, message: string): Promise<string> {
  const attempt = async (s: string | null) =>
    call(fetchFn, t, "PUT", `/repos/${t.repo.trim()}/contents/${encodeURIComponent(t.path)}`, {
      message,
      content: toBase64(text),
      branch: t.branch,
      ...(s ? { sha: s } : {}),
    });
  let res = await attempt(sha);
  if (res.status === 409 || res.status === 422) {
    const current = await getFile(fetchFn, t);
    res = await attempt(current?.sha ?? null);
  }
  if (!res.ok) throw new GitHubError(friendly(res.status, `GitHub error ${res.status} while saving.`), res.status);
  const j = (await res.json()) as { content?: { sha?: string } };
  return j.content?.sha ?? "";
}
