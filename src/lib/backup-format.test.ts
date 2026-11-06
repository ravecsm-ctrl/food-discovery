import { describe, expect, it } from "vitest";
import { checkRepo, encodeBackup, fromBase64, getFile, parseBackup, putFile, toBase64, type Fetch, type GitHubTarget } from "./backup-format";
import type { BackupData } from "./local-store";

const T: GitHubTarget = { token: "test-token", repo: "someone/food-data", branch: "main", path: "food-discovery-backup.json" };
const DATA: BackupData = {
  sessions: [],
  meals: [{ id: "m1", dishId: "dish-chicken-pho", consumedAt: "2026-11-06T12:00:00.000Z", confirmed: true, source: "recall", timeApprox: true }],
  assignment: "rotation",
  profile: { varietySeeking: 1.5 },
};

/** Minimal in-memory fake of the GitHub contents API. */
function fakeGitHub(opts: { private?: boolean; push?: boolean } = {}) {
  const files = new Map<string, { sha: string; content: string }>();
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; auth?: string }> = [];
  let n = 0;
  const fetchFn: Fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status });
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return json(200, { private: opts.private ?? true, default_branch: "main", permissions: { push: opts.push ?? true } });
    const path = decodeURIComponent(url.split("/contents/")[1]!.split("?")[0]!);
    if (method === "GET") {
      const f = files.get(path);
      return f ? json(200, { sha: f.sha, content: f.content, encoding: "base64" }) : json(404, {});
    }
    const existing = files.get(path);
    if (existing && body?.sha !== existing.sha) return json(409, { message: "sha mismatch" });
    const sha = `sha${++n}`;
    files.set(path, { sha, content: String(body?.content) });
    return json(existing ? 200 : 201, { content: { sha } });
  };
  return { fetchFn, files, calls };
}

describe("backup file format", () => {
  it("round-trips data and never contains the token", () => {
    const text = encodeBackup(DATA, "2026-11-06T12:00:00.000Z");
    expect(text).not.toContain("test-token");
    const r = parseBackup(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.data).toEqual(DATA);
  });

  it("rejects files that are not Food Discovery backups", () => {
    expect(parseBackup("not json").ok).toBe(false);
    expect(parseBackup(JSON.stringify({ app: "padel-os", schemaVersion: 1, savedAt: "x", data: {} })).ok).toBe(false);
  });

  it("base64 handles non-ASCII text (dish names, emoji)", () => {
    const s = "Lola's sinigang — ñ 🍲";
    expect(fromBase64(toBase64(s))).toBe(s);
  });
});

describe("GitHub backup client", () => {
  it("refuses a public repository (meal history must stay private)", async () => {
    const gh = fakeGitHub({ private: false });
    await expect(checkRepo(gh.fetchFn, T)).rejects.toThrow(/public/);
  });

  it("refuses a repository the token can't write to", async () => {
    const gh = fakeGitHub({ push: false });
    await expect(checkRepo(gh.fetchFn, T)).rejects.toThrow(/permission/);
  });

  it("creates, then updates the file, and recovers from a stale sha", async () => {
    const gh = fakeGitHub();
    const sha1 = await putFile(gh.fetchFn, T, "v1", null, "first");
    const sha2 = await putFile(gh.fetchFn, T, "v2", sha1, "second");
    const sha3 = await putFile(gh.fetchFn, T, "v3", "stale-sha", "third");
    expect([sha1, sha2, sha3]).toEqual(["sha1", "sha2", "sha3"]);
    expect((await getFile(gh.fetchFn, T))?.text).toBe("v3");
    expect(gh.calls.every((c) => c.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(gh.calls.every((c) => c.auth === "Bearer test-token")).toBe(true);
  });

  it("missing file → null (nothing to restore)", async () => {
    expect(await getFile(fakeGitHub().fetchFn, T)).toBeNull();
  });
});
