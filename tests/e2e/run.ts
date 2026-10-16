// Skenario browser sungguhan (Chromium) terhadap aplikasi Next + PostgREST + Postgres 16.
// Realtime websocket tidak tersedia di sini; yang diuji adalah jalur cadangan (polling) dan seluruh alur UI.
import { chromium, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { ANON_KEY, startStack } from "./stack";

const SHOTS = process.env.SHOTS_DIR ?? "/tmp/claude-0/shots";
const APP = "http://localhost:3100";
const results: { name: string; ok: boolean; err?: string }[] = [];
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); console.log("  ok  ", name); }
  catch (e) { results.push({ name, ok: false, err: (e as Error).message }); console.log("  GAGAL", name, "\n      ", (e as Error).message.split("\n")[0]); }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const stack = await startStack({ accounts: { "tim@jobdesk.example.com": "kode-tim", "lead@jobdesk.example.com": "kode-lead" } });
  await stack.db.query(`
    insert into app_roles (email, role) values ('tim@jobdesk.example.com','cs'), ('lead@jobdesk.example.com','lead') on conflict do nothing;
    insert into team_members (name) values ('Ani'), ('Budi');
    insert into tasks (title, pic, due_at, priority, status, updated_by) values
      ('Balas komentar Instagram', 'Ani', now() - interval '30 minutes', 'high', 'in_progress', 'seed'),
      ('Rekap chat pelanggan', 'Budi', now() + interval '8 minutes', 'medium', 'todo', 'seed'),
      ('Update FAQ', 'Ani', now() + interval '2 days', 'low', 'todo', 'seed');`);

  const next = spawn("npx", ["next", "dev", "-p", "3100"], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: stack.supabaseUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let nextLog = "";
  next.stdout?.on("data", (d) => (nextLog += d));
  next.stderr?.on("data", (d) => (nextLog += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(APP)).status < 500) break; } catch { /* belum siap */ }
    await new Promise((r) => setTimeout(r, 500));
  }

  const exe = readdirSync("/opt/pw-browsers").filter((d) => /^chromium-\d+$/.test(d)).sort().pop()!;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? `/opt/pw-browsers/${exe}/chrome-linux/chrome`, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "America/New_York", acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const login = async (p: Page, who: "Tim CS" | "CS Lead", code: string) => {
    await p.goto(APP);
    await p.getByRole("button", { name: who, exact: true }).click();
    await p.getByLabel(/Kode akses/).fill(code);
    await p.getByRole("button", { name: "Masuk" }).click();
  };

  try {
    await step("login salah menampilkan pesan, login benar masuk dasbor", async () => {
      await login(page, "CS Lead", "salah");
      await page.getByText("Kode akses salah.").waitFor();
      await page.getByLabel(/Kode akses/).fill("kode-lead");
      await page.getByRole("button", { name: "Masuk" }).click();
      await page.getByRole("button", { name: /Tambah jobdesk/ }).first().waitFor();
    });

    await step("kartu statistik menghitung benar", async () => {
      await page.getByText("Balas komentar Instagram").first().waitFor();
      assert.equal((await page.locator(".stat").nth(1).locator(".s-num").textContent())?.trim(), "1"); // terlambat
      assert.equal((await page.locator(".stat").nth(2).locator(".s-num").textContent())?.trim(), "1"); // segera
    });

    await step("jam header memakai WIB walau browser New York", async () => {
      const t = (await page.locator(".brand small").textContent()) ?? "";
      assert.match(t, /WIB/);
      const jakartaHour = new Date(Date.now() + 7 * 3600e3).getUTCHours().toString().padStart(2, "0");
      assert.ok(t.includes(` ${jakartaHour}:`), `jam header "${t}" tidak sama dengan WIB ${jakartaHour}`);
    });

    await step("klik kartu Terlambat memfilter daftar", async () => {
      await page.locator(".stat").nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll(".task").length === 1);
      assert.match((await page.locator(".task").first().textContent()) ?? "", /Balas komentar Instagram/);
      await page.screenshot({ path: `${SHOTS}/lead-1440-late.png` });
      await page.getByRole("tab", { name: /Semua/ }).click();
    });

    await step("pencarian dan filter PIC", async () => {
      await page.getByLabel("Cari jobdesk").fill("faq");
      await page.waitForFunction(() => document.querySelectorAll(".task").length === 1);
      await page.getByLabel("Cari jobdesk").fill("");
      await page.getByLabel("Filter PIC").selectOption("Budi");
      await page.waitForFunction(() => document.querySelectorAll(".task").length === 1);
      await page.getByRole("button", { name: "Hapus semua filter" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".task").length === 3);
    });

    await step("laci tambah jobdesk: fokus di kolom PIC tidak dicuri saat dasbor menggambar ulang", async () => {
      await page.getByRole("button", { name: /\+ Tambah jobdesk/ }).click();
      await page.getByLabel("PIC", { exact: true }).focus();
      await page.waitForTimeout(2600); // dasbor menggambar ulang tiap detik
      const id = await page.evaluate(() => document.activeElement?.id);
      assert.equal(id, "f-pic", `fokus pindah ke "${id}"`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
    });

    await step("tambah jobdesk lewat laci: validasi lalu tersimpan", async () => {
      await page.getByRole("button", { name: /\+ Tambah jobdesk/ }).click();
      await page.getByRole("button", { name: "Tambah jobdesk" }).last().click();
      await page.getByText("Isi judul jobdesk.").waitFor();
      await page.getByText("Pilih PIC.").waitFor();
      await page.getByLabel("Judul").fill("Cek DM malam");
      await page.getByLabel("PIC", { exact: true }).selectOption("Budi");
      await page.getByRole("button", { name: "Tambah jobdesk" }).last().click();
      await page.locator(".task", { hasText: "Cek DM malam" }).waitFor();
      const row = await stack.db.query("select pic, status, created_at is not null as c, updated_by from tasks where title = 'Cek DM malam'");
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].pic, "Budi");
      assert.equal(row.rows[0].updated_by, "CS Lead");
    });

    await step("ubah status cepat dan centang selesai, alasan terlambat dicatat", async () => {
      const late = page.locator(".task", { hasText: "Balas komentar Instagram" });
      await late.getByLabel(/Status Balas/).selectOption("waiting");
      await page.waitForFunction(() => [...document.querySelectorAll(".task")].some((t) => t.textContent?.includes("Balas komentar") && t.textContent?.includes("Menunggu") || (t.querySelector("select") as HTMLSelectElement | null)?.value === "waiting"));
      await late.getByLabel(/Selesaikan Balas/).click();
      await page.getByRole("dialog", { name: "Alasan keterlambatan" }).waitFor();
      await page.getByRole("button", { name: "Simpan alasan" }).click();
      await page.getByText("Pilih alasan keterlambatan.").waitFor();
      await page.getByLabel("Alasan", { exact: true }).selectOption("waiting_info");
      await page.getByRole("button", { name: "Simpan alasan" }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
      const r = await stack.db.query("select done, status, done_at is not null as d, late_reason from tasks where title = 'Balas komentar Instagram'");
      assert.deepEqual(r.rows[0], { done: true, status: "done", d: true, late_reason: "waiting_info" });
      const ev = await stack.db.query("select action from task_events where task_title = 'Balas komentar Instagram' order by id");
      assert.ok(ev.rows.some((e) => e.action === "completed") && ev.rows.some((e) => e.action === "late_reason_set"));
    });

    await step("riwayat aktivitas tampil sebagai kalimat", async () => {
      await page.getByText(/menyelesaikan "Balas komentar Instagram"/).first().waitFor();
    });

    await step("panel tim: tandai tidak masuk menampilkan peringatan jobdesk", async () => {
      await page.locator(".member", { hasText: "Budi" }).getByRole("button", { name: "Tandai tidak masuk" }).click();
      await page.locator(".member", { hasText: "Budi" }).getByText("Tidak masuk").waitFor();
      await page.locator(".member", { hasText: "Budi" }).getByText(/Alihkan ke PIC lain/).waitFor();
    });

    await step("banner peringatan muncul untuk jobdesk mendekati deadline, bisa ditunda", async () => {
      const alert = page.locator(".alert", { hasText: "Rekap chat pelanggan" });
      await alert.waitFor();
      assert.match((await alert.textContent()) ?? "", /Budi/);
      await alert.getByRole("button", { name: "Tunda 5 mnt" }).click();
      await alert.waitFor({ state: "detached" });
    });

    await step("jobdesk berulang dibuat sebagai template dan muncul di halaman Template", async () => {
      await page.getByRole("link", { name: "Template" }).click();
      await page.getByRole("heading", { name: /Template jobdesk berulang/ }).waitFor();
      await page.getByRole("button", { name: "Rekap harian", exact: true }).click();
      await page.getByLabel("PIC", { exact: true }).selectOption("Ani");
      await page.getByRole("button", { name: "Simpan template" }).click();
      await page.locator(".tpl", { hasText: "Rekap harian CS" }).waitFor();
      const n = await stack.db.query("select count(*)::int as c from task_templates where title = 'Rekap harian CS'");
      assert.equal(n.rows[0].c, 1);
      await page.screenshot({ path: `${SHOTS}/lead-1440-template.png` });
    });

    await step("laporan menampilkan metrik, tren, dan mengunduh CSV", async () => {
      await page.getByRole("link", { name: "Laporan" }).click();
      await page.getByRole("heading", { name: "Laporan" }).waitFor();
      await page.getByRole("button", { name: "Harian" }).click();
      await page.getByText("Ketepatan waktu").first().waitFor();
      await page.getByRole("img", { name: /Grafik jobdesk/ }).waitFor();
      const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Unduh daftar jobdesk/ }).click()]);
      const path = await dl.path();
      const text = (await import("node:fs")).readFileSync(path!, "utf8");
      assert.ok(text.startsWith("﻿Judul,PIC"));
      assert.ok(text.includes("Balas komentar Instagram"));
      await page.screenshot({ path: `${SHOTS}/lead-1440-laporan.png`, fullPage: true });
    });

    await step("akun Tim CS: tidak bisa menambah jobdesk, hanya ubah status", async () => {
      const p2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await login(p2, "Tim CS", "kode-tim");
      await p2.getByText("Update FAQ").first().waitFor();
      assert.equal(await p2.getByRole("button", { name: /\+ Tambah jobdesk/ }).count(), 0);
      assert.equal(await p2.getByRole("link", { name: "Template" }).count(), 0);
      await p2.locator(".task", { hasText: "Update FAQ" }).getByLabel(/Status Update/).selectOption("in_progress");
      await p2.waitForTimeout(800);
      const r = await stack.db.query("select status, started_at is not null as s from tasks where title = 'Update FAQ'");
      assert.deepEqual(r.rows[0], { status: "in_progress", s: true });
      // tulis langsung ke database tetap ditolak oleh RLS, bukan hanya disembunyikan di UI
      const res = await p2.evaluate(async ({ url, key }) => {
        const sess = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes("auth-token"))!) ?? "{}");
        const r = await fetch(`${url}/rest/v1/tasks`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${sess.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Curang", pic: "Ani", due_at: new Date().toISOString() }) });
        return r.status;
      }, { url: stack.supabaseUrl, key: ANON_KEY });
      assert.ok(res === 401 || res === 403, `status ${res}`);
      await p2.screenshot({ path: `${SHOTS}/cs-1440.png` });
      await p2.context().close();
    });

    await step("data dari perangkat lain muncul lewat polling tanpa muat ulang", async () => {
      await page.getByRole("link", { name: "Dasbor" }).click();
      await stack.db.query("insert into tasks (title, pic, due_at, updated_by) values ('Dari PC lain', 'Ani', now() + interval '3 days', 'PC2')");
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator(".task", { hasText: "Dari PC lain" }).waitFor({ timeout: 40000 });
    });

    await step("tata letak tanpa scroll horizontal di 1440, 768, dan 390", async () => {
      for (const w of [1440, 768, 390]) {
        await page.setViewportSize({ width: w, height: 900 });
        await page.waitForTimeout(300);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (over > 0) {
          const who = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 6).map((e) => `${e.tagName}.${(e as HTMLElement).className}`.slice(0, 60)));
          assert.fail(`lebar ${w}: meluap ${over}px oleh ${who.join(" | ")}`);
        }
        await page.screenshot({ path: `${SHOTS}/lead-${w}.png`, fullPage: true });
      }
    });

    await step("offline: banner muncul dan data lama tetap tampil", async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await ctx.setOffline(true);
      await page.getByText(/Anda offline/).waitFor();
      assert.ok((await page.locator(".task").count()) > 0);
      await ctx.setOffline(false);
    });

    await step("tidak ada error JavaScript di konsol", async () => {
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    next.kill("SIGTERM");
    await stack.stop();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} skenario lolos`);
  if (failed.length) { console.log(nextLog.slice(-1500)); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
