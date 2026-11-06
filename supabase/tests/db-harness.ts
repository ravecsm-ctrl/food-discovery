/**
 * In-process Postgres (PGlite) with a minimal Supabase-compatible environment: the anon/authenticated
 * roles, an auth.users table and auth.uid(). Lets the real migrations and access rules run in unit
 * tests without Docker or a network. The production database is Supabase Postgres; these tests cover
 * our schema, grants and functions, not Supabase itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, is_anonymous boolean not null default true);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Supabase grants new public objects to API roles by default; reproduce that so our revokes are tested.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
`;

export interface Db {
  pg: PGlite;
  /** Run as a signed-in user (guest or account). */
  as<T = Record<string, unknown>>(user: string, sql: string, params?: unknown[]): Promise<T[]>;
  /** Run as the public API role with no sign-in. */
  asAnon<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run as the database owner (test setup / inspection only). */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  addUser(id: string, opts?: { email?: string }): Promise<void>;
}

export async function createDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(MIGRATIONS + f, "utf8"));
  }
  const run = async <T>(role: string | null, sub: string, sql: string, params: unknown[] = []) => {
    // Sequential tests only: role switching is per connection.
    await pg.exec(`reset role; select set_config('request.jwt.claim.sub', '${sub}', false);${role ? ` set role ${role};` : ""}`);
    try {
      return (await pg.query<T>(sql, params)).rows;
    } finally {
      await pg.exec("reset role;");
    }
  };
  return {
    pg,
    as: (user, sql, params) => run("authenticated", user, sql, params),
    asAnon: (sql, params) => run("anon", "", sql, params),
    admin: (sql, params) => run(null, "", sql, params),
    addUser: async (id, opts) => {
      await run(null, "", "insert into auth.users(id, email, is_anonymous) values ($1, $2, $3)", [id, opts?.email ?? null, !opts?.email]);
    },
  };
}
