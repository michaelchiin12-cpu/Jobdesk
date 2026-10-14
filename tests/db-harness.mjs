// Harness: Postgres lokal (PGlite) yang meniru bagian Supabase yang dipakai skema.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SCHEMA = readFileSync(process.env.SCHEMA_PATH ?? join(here, "../supabase/schema.sql"), "utf8");
export const SCHEMA_V1 = readFileSync(join(here, "fixtures/schema_v1.sql"), "utf8");

export const EMAILS = { lead: "lead@jobdesk.example.com", cs: "tim@jobdesk.example.com", stranger: "orang@lain.com" };

const SUPABASE_STUBS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  create publication supabase_realtime;
  create schema cron;
  create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
  create function cron.unschedule(job_id bigint) returns boolean language sql as $$
    delete from cron.job where jobid = job_id returning true $$;
  create schema net;
  create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                                headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
    returns bigint language sql as $$
    insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
`;

export async function newDb({ legacy = false } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  if (legacy) await db.exec(SCHEMA_V1);
  return db;
}

export async function as(db, who) {
  await db.exec("reset role");
  if (who === "internal") {
    await db.query("select set_config('request.jwt.claims', '', false)");
    return;
  }
  const claims = who === "anon" ? { role: "anon" } : { email: EMAILS[who], role: "authenticated" };
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
  await db.exec(who === "anon" ? "set role anon" : "set role authenticated");
}

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows;
export const one = async (db, sql, params) => (await rows(db, sql, params))[0];
