import { PG_PORT, startPgServer, stopPgServer } from "./pgserver";
const cmd = process.argv[2];
async function main() {
if (cmd === "start") {
  startPgServer();
  // Bersihkan database uji sisa proses sebelumnya.
  const { execFileSync } = await import("node:child_process");
  const psql = (sql: string) => execFileSync("psql", ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", "postgres", "-Atc", sql], { encoding: "utf8" });
  for (const d of psql("select datname from pg_database where datname ~ '^t_[a-z0-9]{8}$'").split("\n").filter(Boolean)) {
    psql(`drop database if exists "${d}" with (force)`);
  }
  console.log("Postgres siap di port", PG_PORT);
} else if (cmd === "stop") {
  stopPgServer();
} else {
  console.error("pakai: pgctl start|stop");
  process.exit(1);
}
}
main();
