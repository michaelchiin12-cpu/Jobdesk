// Tugas berulang: dibuat dari template, tidak boleh duplikat, aman terhadap scheduler yang berjalan berulang.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, CS, failsWith, freshDb, LEAD, newSchemaSql, rows } from "./helpers/pg";

describe("template dan tugas berulang", () => {
  let db: PGlite;
  let today: string;
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => rows<T>(db, sql, p);
  const dateOffset = async (n: number) => (await q<{ d: string }>(`select ((now() at time zone 'Asia/Jakarta')::date + ${n})::text d`))[0].d;
  const isodow = async (n: number) => Number((await q<{ d: string }>(`select extract(isodow from (now() at time zone 'Asia/Jakarta')::date + ${n})::text d`))[0].d);
  const tpl = async (cols: string, vals: string) =>
    (await q<{ id: string }>(`insert into task_templates (title, pic, ${cols}) values ('Tpl', 'Ani', ${vals}) returning id`))[0].id;
  const gen = async (h = 1) => Number((await q<{ n: number }>(`select public.generate_recurring_tasks(${h}) n`))[0].n);
  const tasksOf = (id: string) => q<{ occurrence_date: string; due_hhmm: string; pic: string; priority: string; status: string; done: boolean }>(
    `select occurrence_date::text, to_char(due_at at time zone 'Asia/Jakarta', 'HH24:MI') due_hhmm, pic, priority, status, done
       from tasks where template_id = $1 order by occurrence_date`, [id]);
  const clean = async () => { await db.exec("delete from tasks; delete from task_templates; delete from task_events; delete from notifications;"); };

  before(async () => {
    db = await freshDb();
    await db.exec(newSchemaSql());
    await db.exec("insert into team_members (name) values ('Ani'), ('Budi');");
    today = await dateOffset(0);
  });

  it("aturan jadwal: harian, hari kerja, mingguan, bulanan (termasuk akhir bulan dan Februari kabisat)", async () => {
    const on = async (type: string, wd: number | null, md: number | null, d: string) =>
      (await q<{ r: boolean }>("select public.template_occurs_on($1, $2, $3, $4::date) r", [type, wd, md, d]))[0].r;
    assert.equal(await on("daily", null, null, "2026-10-14"), true);
    assert.equal(await on("weekdays", null, null, "2026-10-12"), true, "Senin");
    assert.equal(await on("weekdays", null, null, "2026-10-16"), true, "Jumat");
    assert.equal(await on("weekdays", null, null, "2026-10-17"), false, "Sabtu");
    assert.equal(await on("weekdays", null, null, "2026-10-18"), false, "Minggu");
    assert.equal(await on("weekly", 3, null, "2026-10-14"), true, "Rabu");
    assert.equal(await on("weekly", 3, null, "2026-10-15"), false);
    assert.equal(await on("weekly", 7, null, "2026-10-18"), true, "Minggu = 7");
    assert.equal(await on("monthly", null, 15, "2026-10-15"), true);
    assert.equal(await on("monthly", null, 15, "2026-10-16"), false);
    assert.equal(await on("monthly", null, 31, "2026-10-31"), true);
    assert.equal(await on("monthly", null, 31, "2026-11-30"), true, "31 jatuh di 30 November");
    assert.equal(await on("monthly", null, 31, "2026-11-29"), false);
    assert.equal(await on("monthly", null, 31, "2027-02-28"), true, "Februari biasa");
    assert.equal(await on("monthly", null, 31, "2027-02-27"), false);
    assert.equal(await on("monthly", null, 30, "2028-02-29"), true, "Februari kabisat");
    assert.equal(await on("monthly", null, 29, "2027-02-28"), true, "29 jatuh di 28 Februari");
    assert.equal(await on("yearly", null, null, "2026-10-14"), false);
  });

  it("membuat tugas hari ini dan besok pada jam template (WIB), lalu tidak menambah lagi", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time, priority", "'daily', '17:00', 'high'");
    assert.equal(await gen(), 2);
    assert.equal(await gen(), 0, "scheduler kedua tidak membuat duplikat");
    assert.equal(await gen(), 0);
    const t = await tasksOf(id);
    assert.deepEqual(t.map((x) => x.occurrence_date), [today, await dateOffset(1)]);
    for (const x of t) assert.deepEqual([x.due_hhmm, x.pic, x.priority, x.status], ["17:00", "Ani", "high", "todo"]);
    const ev = await q<{ actor: string }>("select actor from task_events where action = 'created'");
    assert.ok(ev.length === 2 && ev.every((e) => e.actor === "Sistem"));
    assert.equal((await q("select 1 from notifications where kind = 'assigned'")).length, 0, "tugas otomatis tidak memicu 'jobdesk baru'");
  });

  it("menyelesaikan tugas berulang tidak membuat tugas berikutnya dan tidak menimbulkan duplikat", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '17:00'");
    await gen();
    const before = await tasksOf(id);
    await asUser(db, CS, () => db.query("update tasks set done = true where template_id = $1 and occurrence_date = $2", [id, today]));
    assert.equal(await gen(), 0);
    const after = await tasksOf(id);
    assert.equal(after.length, before.length);
    assert.equal(after.find((x) => x.occurrence_date === today)!.done, true);
    // membuka kembali lalu menyelesaikan lagi juga tidak menambah apa pun
    await asUser(db, LEAD, () => db.query("update tasks set done = false where template_id = $1 and occurrence_date = $2", [id, today]));
    await asUser(db, CS, () => db.query("update tasks set done = true where template_id = $1 and occurrence_date = $2", [id, today]));
    assert.equal(await gen(), 0);
    assert.equal((await tasksOf(id)).length, 2);
  });

  it("hari kerja hanya Senin sampai Jumat", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'weekdays', '09:00'");
    await gen(7);
    const t = await tasksOf(id);
    assert.equal(t.length, (await q<{ n: number }>(
      "select count(*)::int n from generate_series(0, 7) g where extract(isodow from (now() at time zone 'Asia/Jakarta')::date + g) between 1 and 5"))[0].n);
    for (const x of t) {
      const dow = (await q<{ d: number }>("select extract(isodow from $1::date)::int d", [x.occurrence_date]))[0].d;
      assert.ok(dow >= 1 && dow <= 5, `${x.occurrence_date} bukan hari kerja`);
    }
  });

  it("mingguan: hanya pada hari yang dipilih", async () => {
    await clean();
    const wd = await isodow(3);
    const id = await tpl("repeat_type, weekday, due_time", `'weekly', ${wd}, '10:30'`);
    assert.equal(await gen(1), 0, "hari itu 3 hari lagi, di luar jendela");
    assert.equal(await gen(7), 1);
    assert.equal((await tasksOf(id))[0].occurrence_date, await dateOffset(3));
    assert.equal(await gen(7), 0);
  });

  it("bulanan: pada tanggal yang dipilih", async () => {
    await clean();
    const day = Number(today.slice(8, 10));
    const id = await tpl("repeat_type, month_day, due_time", `'monthly', ${day}, '11:00'`);
    assert.equal(await gen(0), 1);
    assert.equal((await tasksOf(id))[0].occurrence_date, today);
  });

  it("tanggal mulai di masa depan ditunda, template nonaktif dan arsip tidak membuat tugas", async () => {
    await clean();
    const later = await tpl("repeat_type, due_time, starts_on", `'daily', '08:00', '${await dateOffset(1)}'`);
    await gen(1);
    assert.deepEqual((await tasksOf(later)).map((x) => x.occurrence_date), [await dateOffset(1)]);
    await clean();
    const off = await tpl("repeat_type, due_time, active", "'daily', '08:00', false");
    const arch = await tpl("repeat_type, due_time, archived_at", "'daily', '08:00', now()");
    assert.equal(await gen(1), 0);
    assert.equal((await tasksOf(off)).length + (await tasksOf(arch)).length, 0);
  });

  it("jendela pembuatan dibatasi maksimal 8 hari ke depan", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '08:00'");
    await gen(100);
    assert.equal((await tasksOf(id)).length, 8);
    await clean();
    const id2 = await tpl("repeat_type, due_time", "'daily', '08:00'");
    await gen(-5);
    assert.deepEqual((await tasksOf(id2)).map((x) => x.occurrence_date), [today]);
  });

  it("database menolak dua tugas untuk template dan tanggal yang sama", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '08:00'");
    await gen(0);
    const code = await failsWith(db, "insert into tasks (title, pic, due_at, template_id, occurrence_date) values ('dup', 'Ani', now(), $1, $2)", [id, today]);
    assert.equal(code, "23505");
  });

  it("template menolak jadwal yang tidak lengkap", async () => {
    await clean();
    const bad = (cols: string, vals: string) => failsWith(db, `insert into task_templates (title, pic, ${cols}) values ('x', 'Ani', ${vals})`);
    assert.equal(await bad("repeat_type", "'weekly'"), "23514", "mingguan tanpa hari");
    assert.equal(await bad("repeat_type, weekday", "'weekly', 8"), "23514");
    assert.equal(await bad("repeat_type", "'monthly'"), "23514", "bulanan tanpa tanggal");
    assert.equal(await bad("repeat_type, month_day", "'monthly', 32"), "23514");
    assert.equal(await bad("repeat_type", "'yearly'"), "23514");
    assert.equal(await bad("repeat_type, remind_before_min", "'daily', 0"), "23514");
    assert.equal(await bad("repeat_type", "'daily'"), null);
  });

  it("mengubah template tidak mengubah tugas yang sudah dibuat, kecuali CS Lead memilih menerapkannya", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '17:00'");
    await gen();
    await db.query("update task_templates set title = 'Judul baru', pic = 'Budi', due_time = '15:00' where id = $1", [id]);
    await gen();
    assert.equal(await gen(), 0, "perubahan template tidak memicu pembuatan ulang");
    const before = await q<{ title: string; pic: string }>("select title, pic from tasks where template_id = $1", [id]);
    assert.ok(before.every((x) => x.title === "Tpl" && x.pic === "Ani"), "tugas lama tidak berubah otomatis");
    // satu tugas sudah selesai: tidak boleh ikut berubah
    await asUser(db, CS, () => db.query("update tasks set done = true where template_id = $1 and occurrence_date = $2", [id, today]));
    assert.equal(await asUser(db, CS, () => failsWith(db, "select public.apply_template_to_open_tasks($1, 'x')", [id])), "42501");
    const n = await asUser(db, LEAD, async () => Number((await rows<{ n: number }>(db, "select public.apply_template_to_open_tasks($1, 'CS Lead') n", [id]))[0].n));
    assert.equal(n, 1, "hanya tugas yang belum selesai");
    const after = await q<{ occurrence_date: string; title: string; pic: string; hhmm: string; done: boolean }>(
      "select occurrence_date::text, title, pic, to_char(due_at at time zone 'Asia/Jakarta','HH24:MI') hhmm, done from tasks where template_id = $1 order by occurrence_date", [id]);
    assert.deepEqual(after.map((x) => [x.done, x.title, x.pic, x.hhmm]), [[true, "Tpl", "Ani", "17:00"], [false, "Judul baru", "Budi", "15:00"]]);
  });

  it("menghentikan pengulangan: tugas yang ada tetap, yang belum dimulai dan belum jatuh tempo bisa diarsipkan", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '17:00'");
    const mk = async (off: number, status: string, due: string) =>
      db.query(`insert into tasks (title, pic, due_at, template_id, occurrence_date, status) values ('t', 'Ani', ${due}, $1, (now() at time zone 'Asia/Jakarta')::date + ${off}, $2)`, [id, status]);
    await mk(2, "todo", "now() + interval '2 days'");
    await mk(3, "in_progress", "now() + interval '3 days'");
    await mk(-1, "todo", "now() - interval '1 day'");
    await mk(4, "done", "now() + interval '4 days'");
    assert.equal(await asUser(db, CS, () => failsWith(db, "select public.stop_template($1, true, 'x')", [id])), "42501");
    const n = await asUser(db, LEAD, async () => Number((await rows<{ n: number }>(db, "select public.stop_template($1, true, 'CS Lead') n", [id]))[0].n));
    assert.equal(n, 1, "hanya yang belum dimulai dan belum jatuh tempo");
    assert.equal((await q("select 1 from tasks where template_id = $1 and archived_at is not null", [id])).length, 1);
    assert.equal((await q("select 1 from tasks where template_id = $1", [id])).length, 4, "tidak ada tugas yang dihapus");
    const t = (await q<{ active: boolean; archived_at: string | null }>("select active, archived_at from task_templates where id = $1", [id]))[0];
    assert.equal(t.active, false);
    assert.ok(t.archived_at);
    assert.equal(await gen(7), 0, "setelah dihentikan tidak ada tugas baru");
  });

  it("menghentikan tanpa mengarsipkan tidak menyentuh tugas yang sudah ada", async () => {
    await clean();
    const id = await tpl("repeat_type, due_time", "'daily', '17:00'");
    await gen();
    const n = await asUser(db, LEAD, async () => Number((await rows<{ n: number }>(db, "select public.stop_template($1, false, 'CS Lead') n", [id]))[0].n));
    assert.equal(n, 0);
    assert.equal((await q("select 1 from tasks where template_id = $1 and archived_at is null", [id])).length, 2);
  });

  it("membuat tugas berulang hanya boleh oleh yang berhak, scheduler (tanpa JWT) boleh", async () => {
    await clean();
    await tpl("repeat_type, due_time", "'daily', '17:00'");
    assert.equal(await asUser(db, CS, () => failsWith(db, "select public.generate_recurring_tasks(1)")), "42501");
    assert.equal(await asUser(db, LEAD, () => failsWith(db, "select public.generate_recurring_tasks(1)")), null);
    assert.equal(await asUser(db, null, () => failsWith(db, "select public.generate_recurring_tasks(1)")), "42501");
  });
});
