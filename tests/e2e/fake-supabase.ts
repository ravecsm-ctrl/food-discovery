/**
 * A stand-in for Supabase Auth + PostgREST RPC, served through Playwright's request interception.
 * RPC calls execute the REAL migrations' functions in PGlite as the calling user, so browser tests
 * exercise the true access rules. Auth is simulated: anonymous sign-up, email change and email
 * codes (the code is always 123456). Nothing leaves the test process.
 */
import type { BrowserContext, Route } from "@playwright/test";
import { createDb, type Db } from "../../supabase/tests/db-harness";

export const TEST_CODE = "123456";

interface FakeUser {
  id: string;
  email: string | null;
  pendingEmail: string | null;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

export class FakeSupabase {
  db!: Db;
  users = new Map<string, FakeUser>();
  /** Every request body the browser sent (to assert what never leaves the phone). */
  bodies: string[] = [];
  private n = 0;

  static async create(): Promise<FakeSupabase> {
    const f = new FakeSupabase();
    f.db = await createDb();
    return f;
  }

  private token(u: FakeUser) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: u.id, exp, role: "authenticated", aud: "authenticated", is_anonymous: !u.email, email: u.email ?? "" })}.sig`;
  }

  private userJson(u: FakeUser) {
    return {
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email ?? "",
      is_anonymous: !u.email,
      app_metadata: { provider: u.email ? "email" : "anonymous" },
      user_metadata: {},
      identities: [],
      created_at: new Date().toISOString(),
    };
  }

  private session(u: FakeUser) {
    return {
      access_token: this.token(u),
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: `refresh-${u.id}`,
      user: this.userJson(u),
    };
  }

  private caller(route: Route): FakeUser | null {
    const auth = route.request().headers()["authorization"] ?? "";
    const tok = auth.replace(/^Bearer /, "");
    const part = tok.split(".")[1];
    if (!part) return null;
    try {
      const sub = (JSON.parse(Buffer.from(part, "base64url").toString()) as { sub?: string }).sub;
      return (sub && this.users.get(sub)) || null;
    } catch {
      return null;
    }
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(/\/auth\/v1\//, (r) => this.auth(r));
    await context.route(/\/rest\/v1\/rpc\//, (r) => this.rpc(r));
  }

  private json(route: Route, status: number, body: unknown) {
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  }

  private async auth(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : {};
    if (req.postData()) this.bodies.push(req.postData()!);
    const path = url.pathname.replace(/.*\/auth\/v1/, "");

    if (path === "/signup" && req.method() === "POST" && !body.email) {
      const u: FakeUser = { id: `aaaaaaaa-0000-4000-8000-${String(++this.n).padStart(12, "0")}`, email: null, pendingEmail: null };
      this.users.set(u.id, u);
      await this.db.addUser(u.id);
      return this.json(route, 200, this.session(u));
    }
    if (path === "/user" && req.method() === "GET") {
      const u = this.caller(route);
      return u ? this.json(route, 200, this.userJson(u)) : this.json(route, 401, { code: 401, msg: "invalid JWT" });
    }
    if (path === "/user" && req.method() === "PUT") {
      const u = this.caller(route);
      if (!u) return this.json(route, 401, { code: 401, msg: "invalid JWT" });
      u.pendingEmail = String(body.email);
      return this.json(route, 200, { ...this.userJson(u), new_email: u.pendingEmail });
    }
    if (path === "/otp" && req.method() === "POST") {
      const exists = [...this.users.values()].some((u) => u.email === body.email);
      if (!exists) return this.json(route, 422, { code: 422, error_code: "otp_disabled", msg: "Signups not allowed for otp" });
      return this.json(route, 200, {});
    }
    if (path === "/verify" && req.method() === "POST") {
      if (body.token !== TEST_CODE) return this.json(route, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      if (body.type === "email_change") {
        const u = [...this.users.values()].find((x) => x.pendingEmail === body.email);
        if (!u) return this.json(route, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
        u.email = u.pendingEmail;
        u.pendingEmail = null;
        await this.db.admin("update auth.users set email = $2, is_anonymous = false where id = $1", [u.id, u.email]);
        return this.json(route, 200, this.session(u));
      }
      const u = [...this.users.values()].find((x) => x.email === body.email);
      if (!u) return this.json(route, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      return this.json(route, 200, this.session(u));
    }
    if (path === "/token" && url.searchParams.get("grant_type") === "refresh_token") {
      const id = String(body.refresh_token ?? "").replace("refresh-", "");
      const u = this.users.get(id);
      return u ? this.json(route, 200, this.session(u)) : this.json(route, 400, { code: 400, msg: "Invalid Refresh Token" });
    }
    if (path === "/logout") return route.fulfill({ status: 204 });
    return this.json(route, 404, { msg: `fake auth: ${req.method()} ${path} not implemented` });
  }

  private async rpc(route: Route) {
    const req = route.request();
    const fn = new URL(req.url()).pathname.split("/").pop()!;
    if (!/^[a-z_]+$/.test(fn)) return this.json(route, 404, { message: "not found" });
    const raw = req.postData() ?? "{}";
    this.bodies.push(raw);
    const args = JSON.parse(raw) as Record<string, unknown>;
    const u = this.caller(route);
    const names = Object.keys(args);
    const sql = `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    const params = names.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]));
    try {
      const rows = u ? await this.db.as<{ r: unknown }>(u.id, sql, params) : await this.db.asAnon<{ r: unknown }>(sql, params);
      if (fn === "delete_my_account" && u) this.users.delete(u.id);
      return this.json(route, 200, rows[0]?.r ?? null);
    } catch (e) {
      return this.json(route, 400, { code: "P0001", message: e instanceof Error ? e.message : String(e), details: null, hint: null });
    }
  }
}
