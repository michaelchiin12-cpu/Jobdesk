// Tumpukan uji end-to-end lokal: PGlite (Postgres) + PostgREST asli + gerbang mirip Supabase (auth + REST).
// Realtime (websocket) sengaja tidak tersedia: aplikasi harus tetap bekerja lewat polling.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { newSchemaSql } from "../helpers/pg";

export const JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123456789";
export const PGRST_BIN = process.env.PGRST_BIN ?? "/tmp/claude-0/pgrst/postgrest";

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
export function signJwt(claims: Record<string, unknown>, ttlSec = 3600): string {
  const head = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64(JSON.stringify({ iss: "e2e", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec, ...claims }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
export const ANON_KEY = signJwt({ role: "anon" }, 10 * 365 * 86400);
const uid = (email: string) => crypto.createHash("md5").update(email).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5");

const BOOTSTRAP = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator;
create schema auth; create schema extensions;
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

export interface Stack {
  db: PGlite;
  supabaseUrl: string;
  accounts: Record<string, string>;
  stop(): Promise<void>;
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 30000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout menunggu ${what}`);
}

export async function startStack(opts: { pgPort?: number; restPort?: number; gatewayPort?: number; accounts: Record<string, string> }): Promise<Stack> {
  const pgPort = opts.pgPort ?? 54320;
  const restPort = opts.restPort ?? 54322;
  const gwPort = opts.gatewayPort ?? 54321;

  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(newSchemaSql());

  const socket = new PGLiteSocketServer({ db, port: pgPort, host: "127.0.0.1", maxConnections: 1 });
  await socket.start();

  let logs = "";
  const pgrst: ChildProcess = spawn(PGRST_BIN, [], {
    env: {
      PGRST_DB_URI: `postgres://authenticator@127.0.0.1:${pgPort}/postgres?sslmode=disable`,
      PGRST_DB_SCHEMAS: "public",
      PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: JWT_SECRET,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(restPort),
      PGRST_DB_POOL: "1",
      PGRST_DB_CHANNEL_ENABLED: "false",
      PGRST_DB_PREPARED_STATEMENTS: "false",
      PGRST_LOG_LEVEL: process.env.PGRST_LOG_LEVEL ?? "warn",
      PATH: process.env.PATH ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  pgrst.stdout?.on("data", (d) => { logs += d; if (process.env.E2E_DEBUG) process.stderr.write(d); });
  pgrst.stderr?.on("data", (d) => { logs += d; if (process.env.E2E_DEBUG) process.stderr.write(d); });
  pgrst.on("exit", (c) => (logs += `\n[postgrest keluar kode ${c}]`));

  const sessions = new Map<string, string>(); // refresh_token -> email
  const session = (email: string) => {
    const refresh = "r-" + crypto.randomBytes(12).toString("hex");
    sessions.set(refresh, email);
    const access = signJwt({ sub: uid(email), role: "authenticated", email, aud: "authenticated" });
    return {
      access_token: access, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refresh,
      user: { id: uid(email), aud: "authenticated", role: "authenticated", email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    };
  };

  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "content-range,content-type",
  };
  const send = (res: http.ServerResponse, code: number, body?: unknown) => {
    res.writeHead(code, { ...cors, "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

  const gateway = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${gwPort}`);
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    try {
      if (url.pathname.startsWith("/rest/v1/")) {
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length", "origin", "referer"].includes(k)) headers[k] = v;
        const up = http.request({ host: "127.0.0.1", port: restPort, method: req.method, path: url.pathname.replace("/rest/v1", "") + url.search, headers: { ...headers, "content-length": String(body.length) } }, (ur) => {
          res.writeHead(ur.statusCode ?? 502, { ...ur.headers, ...cors });
          ur.pipe(res);
        });
        up.on("error", (e) => send(res, 502, { message: "PostgREST tidak tersedia: " + e.message + " | " + logs.slice(-400) }));
        up.end(body);
        return;
      }
      if (url.pathname === "/auth/v1/token" && req.method === "POST") {
        const grant = url.searchParams.get("grant_type");
        const body = JSON.parse((await readBody(req)).toString() || "{}") as { email?: string; password?: string; refresh_token?: string };
        if (grant === "password") {
          const email = String(body.email ?? "").toLowerCase();
          if (opts.accounts[email] !== undefined && opts.accounts[email] === body.password) return send(res, 200, session(email));
          return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
        }
        if (grant === "refresh_token") {
          const email = sessions.get(String(body.refresh_token));
          if (email) return send(res, 200, session(email));
          return send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
        }
      }
      if (url.pathname === "/auth/v1/user") {
        const tok = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        try {
          const claims = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { email?: string };
          if (claims.email) return send(res, 200, session(claims.email).user);
        } catch { /* token tidak valid */ }
        return send(res, 401, { code: 401, msg: "invalid JWT" });
      }
      if (url.pathname === "/auth/v1/logout") return send(res, 204);
      return send(res, 404, { message: "tidak ada" });
    } catch (e) {
      send(res, 500, { message: String(e) });
    }
  });
  await new Promise<void>((r) => gateway.listen(gwPort, "127.0.0.1", r));

  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${restPort}/`, { headers: { apikey: ANON_KEY } });
    return r.status === 200;
  }, `PostgREST (log: ${logs.slice(-600)})`).catch((e) => { throw new Error(`${e.message}\n${logs}`); });

  return {
    db,
    supabaseUrl: `http://127.0.0.1:${gwPort}`,
    accounts: opts.accounts,
    async stop() {
      gateway.close();
      pgrst.kill("SIGTERM");
      await socket.stop().catch(() => undefined);
      await db.close().catch(() => undefined);
    },
  };
}
