// Postgres 16 sungguhan (paket sistem) untuk uji yang lebih setia dari PGlite.
// Dijalankan sebagai pengguna 'postgres' pada klaster sementara di port 54329.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const PG_PORT = Number(process.env.E2E_PG_PORT ?? 54329);
const BIN = "/usr/lib/postgresql/16/bin";
const DATA = "/var/lib/postgresql/jobdesk-test-data";
const SOCK = "/var/lib/postgresql/jobdesk-test-sock";

const asPostgres = (cmd: string, args: string[]) =>
  execFileSync("runuser", ["-u", "postgres", "--", cmd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function pgAvailable(): boolean {
  return existsSync(`${BIN}/postgres`) && spawnSync("id", ["postgres"]).status === 0;
}

export function pgRunning(): boolean {
  return spawnSync(`${BIN}/pg_isready`, ["-h", "127.0.0.1", "-p", String(PG_PORT)]).status === 0;
}

export function startPgServer(): void {
  if (pgRunning()) return;
  if (!existsSync(DATA)) {
    asPostgres("mkdir", ["-p", SOCK]);
    asPostgres(`${BIN}/initdb`, ["-D", DATA, "--auth=trust", "-U", "postgres", "--no-sync"]);
  }
  asPostgres("mkdir", ["-p", SOCK]);
  asPostgres(`${BIN}/pg_ctl`, [
    "-D", DATA, "-l", `${DATA}/server.log`, "-w", "-t", "60",
    "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${SOCK} -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=100`,
    "start",
  ]);
}

export function stopPgServer(): void {
  if (!pgRunning()) return;
  try { asPostgres(`${BIN}/pg_ctl`, ["-D", DATA, "-m", "fast", "-w", "stop"]); } catch { /* sudah berhenti */ }
}
