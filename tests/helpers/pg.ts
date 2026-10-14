// Postgres lokal (PGlite) yang meniru bagian Supabase yang dipakai skema:
// peran anon/authenticated, auth.jwt(), publikasi realtime, dan stub pg_net.
import { PGlite } from "@electric-sql/pglite";
import { Client } from "pg";
import { PG_PORT } from "./pgserver";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(__dirname, "../..");
export const LEAD = "lead@jobdesk.example.com";
export const CS = "tim@jobdesk.example.com";
export const OUTSIDER = "orang-lain@example.com";

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create schema extensions;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
grant usage on schema auth, extensions to anon, authenticated;
grant usage on schema public to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated;
create publication supabase_realtime;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
create schema net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint
language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
`;

export const OLD_SCHEMA_COMMIT = "19a0646";

export function oldSchemaSql(): string {
  return execFileSync("git", ["show", `${OLD_SCHEMA_COMMIT}:supabase/schema.sql`], { cwd: ROOT, encoding: "utf8" });
}

export const newSchemaSql = (): string => readFileSync(path.join(ROOT, "supabase/schema.sql"), "utf8");

/** Antarmuka minimal yang dipakai tes; dipenuhi PGlite maupun adaptor Postgres sungguhan. */
export interface Db {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}

class RealPg implements Db {
  constructor(private client: Client, private name: string) {}
  async exec(sql: string) { return this.client.query(sql); }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const r = await this.client.query(sql, params as unknown[]);
    return { rows: r.rows as T[] };
  }
  async close() {
    await this.client.end();
    const admin = new Client({ host: "127.0.0.1", port: PG_PORT, user: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query(`drop database if exists "${this.name}" with (force)`);
    await admin.end();
  }
}

export const ENGINE = process.env.DB_ENGINE === "pg" ? "pg" : "pglite";

export async function freshDb(): Promise<PGlite> {
  if (ENGINE === "pg") {
    const name = "t_" + Math.random().toString(36).slice(2, 10);
    const admin = new Client({ host: "127.0.0.1", port: PG_PORT, user: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    await admin.end();
    const client = new Client({ host: "127.0.0.1", port: PG_PORT, user: "postgres", database: name });
    await client.connect();
    const db = new RealPg(client, name);
    await db.exec(BOOTSTRAP);
    return db as unknown as PGlite;
  }
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  return db;
}

export async function reset(db: PGlite): Promise<void> {
  await db.exec("reset role; select set_config('request.jwt.claims', '', false);");
}

/** Jalankan fn sebagai pengguna Supabase (JWT + peran authenticated). email null = anon tanpa JWT. */
export async function asUser<T>(db: PGlite, email: string | null, fn: () => Promise<T>): Promise<T> {
  await reset(db);
  if (email === null) {
    await db.exec("set role anon");
  } else {
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ email, role: "authenticated" })]);
    await db.exec("set role authenticated");
  }
  try {
    return await fn();
  } finally {
    await reset(db);
  }
}

/** Hasil query dengan timestamp dinormalkan ke teks ISO (PGlite mengembalikan objek Date). */
export async function rows<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<Record<string, unknown>>(sql, params);
  return res.rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o as T;
  });
}

/** Eksekusi yang diharapkan ditolak database. Mengembalikan kode error SQLSTATE atau null jika berhasil. */
export async function failsWith(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}
