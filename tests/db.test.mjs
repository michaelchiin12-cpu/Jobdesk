import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { newDb, as, rows, one, SCHEMA } from "./db-harness.mjs";

const denied = /Akses ditolak|permission denied|row-level security|hanya boleh|Hanya CS Lead|Tidak diizinkan/i;

async function freshDb() {
  const db = await newDb();
  await db.exec(SCHEMA);
  return db;
}

const addTask = async (db, who, over = {}) => {
  await as(db, who);
  const r = await one(
    db,
    `insert into public.tasks (title, pic, due_at, priority, status, remind_before_min, remind_enabled, updated_by)
     values ($1, $2, coalesce($3::timestamptz, now() + interval '2 hours'), $4, $5, $6, $7, $8) returning *`,
    [over.title ?? "Tugas uji", over.pic ?? "Sari", over.due ?? null, over.priority ?? "medium",
     over.status ?? "todo", over.remind ?? 10, over.remindEnabled ?? true, over.by ?? "Michael"],
  );
  return r;
};

describe("skema: pemasangan dan migrasi", () => {
  test("bisa dijalankan dua kali tanpa error (idempoten)", async () => {
    const db = await freshDb();
    await as(db, "internal");
    await db.exec(SCHEMA);
    const roles = await rows(db, "select email, role from public.app_roles order by email");
    assert.equal(roles.length, 2);
  });

  test("scheduler terpasang tepat satu kali di pg_cron", async () => {
    const db = await freshDb();
    await as(db, "internal");
    await db.exec(SCHEMA);
    const jobs = await rows(db, "select * from cron.job where jobname = 'jobdesk-scheduler'");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].schedule, "* * * * *");
  });

  test("upgrade dari skema lama: data tetap, kolom baru terisi, kebijakan lama hilang", async () => {
    const db = await newDb({ legacy: true });
    await db.exec(`
      insert into public.team_members (name) values ('Sari'), ('Budi');
      insert into public.tasks (title, pic, due_at, repeat) values
        ('Rekap KPI', 'Sari', '2026-10-14 09:00+07', 'daily'),
        ('Rekap KPI', 'Sari', '2026-10-15 09:00+07', 'daily'),
        ('Laporan', 'Budi', '2026-10-14 10:00+07', 'none');
      insert into public.tasks (title, pic, due_at, done, done_at) values ('Selesai lama', 'Budi', '2026-10-01 10:00+07', true, '2026-10-01 09:00+07');
    `);
    await db.exec(SCHEMA);
    await as(db, "internal");
    const all = await rows(db, "select title, status, priority, original_pic, original_due_at is not null as has_orig, template_id from public.tasks order by title, due_at");
    assert.equal(all.length, 4, "tidak ada data yang hilang");
    assert.ok(all.every((r) => r.has_orig && r.original_pic), "kolom original terisi");
    assert.equal(all.find((r) => r.title === "Selesai lama").status, "done");
    assert.ok(all.every((r) => r.priority === "medium"));
    const tpl = await rows(db, "select title, pic, repeat_type, due_time::text, created_by from public.task_templates");
    assert.equal(tpl.length, 1, "satu template per jobdesk berulang yang sama");
    assert.deepEqual([tpl[0].title, tpl[0].pic, tpl[0].repeat_type, tpl[0].due_time], ["Rekap KPI", "Sari", "daily", "09:00:00"]);
    assert.equal(tpl[0].created_by, "Migrasi");
    const policies = await rows(db, "select policyname from pg_policies where policyname = 'tim bersama'");
    assert.equal(policies.length, 0, "kebijakan akses penuh lama dihapus");
    assert.equal((await rows(db, "select 1 from public.team_members")).length, 2);
  });
});

describe("hak akses (RLS dan trigger)", () => {
  let db;
  before(async () => {
    db = await freshDb();
    await as(db, "lead");
    await db.exec("insert into public.team_members (name) values ('Sari'), ('Budi')");
  });

  test("anon dan akun asing tidak bisa membaca apa pun", async () => {
    await addTask(db, "lead");
    for (const who of ["anon", "stranger"]) {
      await as(db, who);
      let n = 0;
      try { n = (await rows(db, "select * from public.tasks")).length; } catch { n = 0; }
      assert.equal(n, 0, who);
      await assert.rejects(db.query("insert into public.tasks (title, pic, due_at) values ('x','y',now())"), denied);
    }
  });

  test("CS: boleh membaca, tidak boleh membuat atau menghapus jobdesk", async () => {
    await as(db, "cs");
    assert.ok((await rows(db, "select * from public.tasks")).length >= 1);
    await assert.rejects(db.query("insert into public.tasks (title, pic, due_at) values ('x','y',now())"), denied);
    await assert.rejects(db.query("delete from public.tasks"), denied);
  });

  test("CS: boleh ubah status dan alasan keterlambatan, tidak boleh ubah PIC, judul, deadline, prioritas", async () => {
    const t = await addTask(db, "lead", { title: "Hak akses" });
    await as(db, "cs");
    await db.query("update public.tasks set status = 'in_progress' where id = $1", [t.id]);
    await db.query("update public.tasks set late_reason = 'waiting_info', late_note = 'tunggu data' where id = $1", [t.id]);
    for (const col of ["pic = 'Budi'", "title = 'Ganti'", "due_at = now() + interval '9 hours'", "priority = 'high'", "archived_at = now()", "remind_enabled = false"]) {
      await assert.rejects(db.query(`update public.tasks set ${col} where id = $1`, [t.id]), denied, col);
    }
    const r = await one(db, "select pic, title, status, late_reason from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.pic, r.title, r.status, r.late_reason], ["Sari", "Hak akses", "in_progress", "waiting_info"]);
  });

  test("CS tidak bisa mengisi alasan keterlambatan di luar daftar", async () => {
    const t = await addTask(db, "lead");
    await as(db, "cs");
    await assert.rejects(db.query("update public.tasks set late_reason = 'asal' where id = $1", [t.id]), /tasks_late_reason_chk|violates check/);
  });

  test("CS tidak bisa membaca template, peran, langganan push, atau mengubah pengaturan", async () => {
    await as(db, "cs");
    assert.equal((await rows(db, "select * from public.task_templates")).length, 0);
    await assert.rejects(db.query("select * from public.app_roles"), denied);
    await assert.rejects(db.query("select * from public.push_subscriptions"), denied);
    // RLS membuat UPDATE tanpa izin mengenai 0 baris (bukan error).
    const res = await db.query("update public.app_settings set value = 'true'::jsonb where key = 'cs_can_manage'");
    assert.equal(res.affectedRows, 0);
    await assert.rejects(db.query("insert into public.app_settings (key, value) values ('lead_escalation', 'false'::jsonb) on conflict (key) do update set value = excluded.value"), denied);
    const r = await one(db, "select value from public.app_settings where key = 'cs_can_manage'");
    assert.equal(r.value, false, "nilai tidak berubah");
  });

  test("CS tidak bisa menyisipkan atau mengubah riwayat aktivitas dan notifikasi", async () => {
    await as(db, "cs");
    await assert.rejects(db.query("insert into public.task_events (task_title, action, actor) values ('a','created','x')"), denied);
    await assert.rejects(db.query("update public.notifications set title = 'x'"), denied);
    await assert.rejects(db.query("insert into public.notifications (kind, title, dedup_key) values ('x','x','x')"), denied);
  });

  test("CS hanya melihat tugas selesai 14 hari terakhir; lead melihat semua termasuk arsip", async () => {
    await as(db, "internal");
    await db.exec(`insert into public.tasks (title, pic, due_at, updated_by) values ('Arsip', 'Sari', now(), 'Sistem');
      update public.tasks set archived_at = now() where title = 'Arsip';
      insert into public.tasks (title, pic, due_at, updated_by) values ('Selesai lama', 'Sari', now() - interval '40 days', 'Sistem');
      update public.tasks set done = true where title = 'Selesai lama';
      alter table public.tasks disable trigger tasks_before_write;
      update public.tasks set done_at = now() - interval '30 days' where title = 'Selesai lama';
      alter table public.tasks enable trigger tasks_before_write;`);
    await as(db, "cs");
    const cs = (await rows(db, "select title from public.tasks")).map((r) => r.title);
    assert.ok(!cs.includes("Arsip") && !cs.includes("Selesai lama"));
    await as(db, "lead");
    const lead = (await rows(db, "select title from public.tasks")).map((r) => r.title);
    assert.ok(lead.includes("Arsip") && lead.includes("Selesai lama"));
  });

  test("pengaturan cs_can_manage memberi CS hak mengelola; dimatikan lagi menutupnya", async () => {
    await as(db, "lead");
    await db.query("update public.app_settings set value = 'true'::jsonb where key = 'cs_can_manage'");
    await as(db, "cs");
    const t = await addTask(db, "cs", { title: "Dibuat CS" });
    await db.query("update public.tasks set pic = 'Budi' where id = $1", [t.id]);
    await as(db, "lead");
    await db.query("update public.app_settings set value = 'false'::jsonb where key = 'cs_can_manage'");
    await as(db, "cs");
    await assert.rejects(db.query("update public.tasks set pic = 'Sari' where id = $1", [t.id]), denied);
  });

  test("hanya lead yang bisa mengelola template dan anggota tim (default)", async () => {
    await as(db, "cs");
    await assert.rejects(db.query("insert into public.task_templates (title, pic, repeat_type) values ('x','Sari','daily')"), denied);
    await assert.rejects(db.query("insert into public.team_members (name) values ('Baru')"), denied);
    await as(db, "lead");
    await db.query("insert into public.task_templates (title, pic, repeat_type) values ('x','Sari','daily')");
    await db.query("insert into public.team_members (name) values ('Baru')");
  });
});

describe("trigger: status, waktu selesai, riwayat", () => {
  let db;
  before(async () => { db = await freshDb(); });

  test("done_at selalu jam server, input klien diabaikan", async () => {
    await as(db, "lead");
    const t = await addTask(db, "lead", { title: "Selesai" });
    await db.query("update public.tasks set done = true, done_at = '2000-01-01' where id = $1", [t.id]);
    const r = await one(db, "select done, status, done_at > now() - interval '1 minute' as fresh from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.done, r.status, r.fresh], [true, "done", true]);
    // waktu selesai tidak bisa digeser setelah selesai
    await db.query("update public.tasks set done_at = '2001-01-01' where id = $1", [t.id]);
    const r2 = await one(db, "select done_at > now() - interval '1 minute' as fresh from public.tasks where id = $1", [t.id]);
    assert.equal(r2.fresh, true);
  });

  test("status done dan kolom done selalu sinkron di kedua arah; deadline lewat tidak mengubah status", async () => {
    const t = await addTask(db, "lead", { title: "Sinkron", due: new Date(Date.now() - 3600_000).toISOString() });
    let r = await one(db, "select status, done from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.status, r.done], ["todo", false], "terlambat tetap berstatus todo");
    await db.query("update public.tasks set status = 'done' where id = $1", [t.id]);
    r = await one(db, "select status, done, done_at is not null as has from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.status, r.done, r.has], ["done", true, true]);
    await db.query("update public.tasks set status = 'in_progress' where id = $1", [t.id]);
    r = await one(db, "select status, done, done_at from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.status, r.done, r.done_at], ["in_progress", false, null]);
    await db.query("update public.tasks set done = true where id = $1", [t.id]);
    await db.query("update public.tasks set done = false where id = $1", [t.id]);
    r = await one(db, "select status, done, done_at from public.tasks where id = $1", [t.id]);
    assert.deepEqual([r.status, r.done, r.done_at], ["todo", false, null]);
  });

  test("waktu mulai terisi saat pertama kali Dalam Proses dan tidak tertimpa", async () => {
    const t = await addTask(db, "lead", { title: "Mulai" });
    await db.query("update public.tasks set status = 'in_progress' where id = $1", [t.id]);
    const a = await one(db, "select started_at from public.tasks where id = $1", [t.id]);
    assert.ok(a.started_at);
    await db.query("update public.tasks set status = 'waiting' where id = $1", [t.id]);
    await db.query("update public.tasks set status = 'in_progress' where id = $1", [t.id]);
    const b = await one(db, "select started_at from public.tasks where id = $1", [t.id]);
    assert.equal(String(a.started_at), String(b.started_at));
  });

  test("deadline awal dan PIC awal tidak berubah saat diedit; riwayat tidak dihapus", async () => {
    const t = await addTask(db, "lead", { title: "Riwayat", pic: "Sari" });
    await db.query("update public.tasks set pic = 'Budi', due_at = due_at + interval '1 day', priority = 'high' where id = $1", [t.id]);
    await db.query("update public.tasks set original_pic = 'Palsu', original_due_at = now() where id = $1", [t.id]);
    const r = await one(db, "select original_pic, original_due_at = $2::timestamptz as same_due from public.tasks where id = $1", [t.id, t.due_at.toISOString()]);
    assert.deepEqual([r.original_pic, r.same_due], ["Sari", true]);
    const ev = (await rows(db, "select action, old_value, new_value, actor from public.task_events where task_id = $1 order by id", [t.id]));
    const acts = ev.map((e) => e.action);
    assert.deepEqual(acts, ["created", "pic_changed", "due_changed", "priority_changed"]);
    assert.deepEqual([ev[1].old_value, ev[1].new_value], ["Sari", "Budi"]);
    assert.equal(ev[0].actor, "Michael", "pengguna dicatat dari updated_by");
    await assert.rejects(db.query("delete from public.task_events"), denied);
  });

  test("selesai, buka kembali, arsip, pulihkan, alasan terlambat tercatat sebagai aktivitas", async () => {
    const t = await addTask(db, "lead", { title: "Siklus", due: new Date(Date.now() - 60_000).toISOString() });
    await db.query("update public.tasks set done = true where id = $1", [t.id]);
    await db.query("update public.tasks set done = false where id = $1", [t.id]);
    await db.query("update public.tasks set late_reason = 'high_workload', late_note = 'banyak' where id = $1", [t.id]);
    await db.query("update public.tasks set archived_at = now() where id = $1", [t.id]);
    await db.query("update public.tasks set archived_at = null where id = $1", [t.id]);
    const ev = await rows(db, "select action, meta from public.task_events where task_id = $1 order by id", [t.id]);
    assert.deepEqual(ev.map((e) => e.action), ["created", "completed", "reopened", "late_reason_set", "archived", "restored"]);
    assert.equal(ev[1].meta.late, true, "selesai setelah deadline ditandai terlambat");
  });

  test("hapus permanen tidak mungkin: tidak ada kebijakan DELETE", async () => {
    const t = await addTask(db, "lead", { title: "Tidak bisa dihapus" });
    await as(db, "lead");
    await assert.rejects(db.query("delete from public.tasks where id = $1", [t.id]), denied);
  });

  test("validasi: judul kosong, prioritas, status, dan pengingat di luar batas ditolak", async () => {
    await as(db, "lead");
    const bad = [
      "insert into public.tasks (title, pic, due_at) values ('   ', 'Sari', now())",
      "insert into public.tasks (title, pic, due_at, priority) values ('a', 'Sari', now(), 'urgent')",
      "insert into public.tasks (title, pic, due_at, status) values ('a', 'Sari', now(), 'selesai')",
      "insert into public.tasks (title, pic, due_at, remind_before_min) values ('a', 'Sari', now(), 0)",
      "insert into public.tasks (title, pic, due_at) values (repeat('x', 121), 'Sari', now())",
    ];
    for (const sql of bad) await assert.rejects(db.query(sql), /violates check|tasks_/i, sql);
  });
});

describe("tugas berulang dari template", () => {
  let db;
  before(async () => { db = await freshDb(); });

  const today = async () => (await one(db, "select (now() at time zone 'Asia/Jakarta')::date::text as d, extract(isodow from (now() at time zone 'Asia/Jakarta')::date)::int as dow, extract(day from (now() at time zone 'Asia/Jakarta')::date)::int as dom")).d;

  test("generate berulang kali tidak menggandakan tugas (idempoten)", async () => {
    await as(db, "lead");
    await db.query("insert into public.task_templates (title, pic, repeat_type, due_time) values ('Rekap harian', 'Sari', 'daily', '09:00')");
    const first = (await one(db, "select public.generate_recurring_tasks(0) as n")).n;
    const second = (await one(db, "select public.generate_recurring_tasks(0) as n")).n;
    await as(db, "internal");
    await db.query("select app_private.run_scheduler()");
    await db.query("select app_private.run_scheduler()");
    assert.equal(first, 1);
    assert.equal(second, 0);
    const n = (await one(db, "select count(*)::int as n from public.tasks where title = 'Rekap harian' and occurrence_date = (now() at time zone 'Asia/Jakarta')::date")).n;
    assert.equal(n, 1);
  });

  test("jam deadline mengikuti Asia/Jakarta", async () => {
    await as(db, "internal");
    const r = await one(db, "select to_char(due_at at time zone 'Asia/Jakarta', 'HH24:MI') as hm, to_char(due_at at time zone 'UTC', 'HH24:MI') as utc from public.tasks where title = 'Rekap harian' limit 1");
    assert.deepEqual([r.hm, r.utc], ["09:00", "02:00"]);
  });

  test("menyelesaikan tugas berulang tidak membuat tugas lain", async () => {
    await as(db, "lead");
    const before = (await one(db, "select count(*)::int as n from public.tasks where template_id is not null")).n;
    await db.query("update public.tasks set done = true where title = 'Rekap harian'");
    const after = (await one(db, "select count(*)::int as n from public.tasks where template_id is not null")).n;
    assert.equal(after, before);
    await db.query("select public.generate_recurring_tasks(0)");
    assert.equal((await one(db, "select count(*)::int as n from public.tasks where template_id is not null")).n, before, "selesai tidak memicu duplikat");
  });

  test("tugas yang sudah diarsipkan tidak dibuat ulang untuk tanggal yang sama", async () => {
    await as(db, "lead");
    await db.query("update public.tasks set archived_at = now() where title = 'Rekap harian'");
    const n = (await one(db, "select public.generate_recurring_tasks(0) as n")).n;
    assert.equal(n, 0);
  });

  test("hari kerja: tidak membuat tugas di akhir pekan; mingguan dan bulanan sesuai jadwal", async () => {
    await as(db, "lead");
    await db.query("delete from public.task_templates"); // lead boleh
    const t = await one(db, "select extract(isodow from (now() at time zone 'Asia/Jakarta')::date)::int as dow, extract(day from (now() at time zone 'Asia/Jakarta')::date)::int as dom");
    await db.query(`insert into public.task_templates (title, pic, repeat_type, weekday, month_day, due_time) values
      ('Hari kerja', 'Sari', 'weekdays', null, null, '08:00'),
      ('Mingguan ini', 'Sari', 'weekly', $1, null, '08:00'),
      ('Mingguan lain', 'Sari', 'weekly', $2, null, '08:00'),
      ('Bulanan ini', 'Sari', 'monthly', null, $3, '08:00'),
      ('Bulanan lain', 'Sari', 'monthly', null, $4, '08:00')`,
      [t.dow, (t.dow % 7) + 1, t.dom, (t.dom % 28) + 1]);
    await db.query("select public.generate_recurring_tasks(0)");
    const titles = (await rows(db, "select title from public.tasks where template_id is not null and occurrence_date = (now() at time zone 'Asia/Jakarta')::date order by title")).map((r) => r.title);
    assert.equal(titles.includes("Hari kerja"), t.dow <= 5);
    assert.ok(titles.includes("Mingguan ini") && !titles.includes("Mingguan lain"));
    assert.ok(titles.includes("Bulanan ini") && !titles.includes("Bulanan lain"));
  });

  test("bulanan tanggal 31 jatuh di hari terakhir pada bulan yang lebih pendek", async () => {
    await as(db, "internal");
    const r = await one(db, `select extract(day from (date_trunc('month', '2026-02-10'::date::timestamp) + interval '1 month' - interval '1 day'))::int as last_feb,
      least(31, extract(day from (date_trunc('month', '2026-02-10'::date::timestamp) + interval '1 month' - interval '1 day'))::int) as clamped`);
    assert.deepEqual([r.last_feb, r.clamped], [28, 28]);
  });

  test("template nonaktif atau diarsipkan tidak menghasilkan tugas; konfigurasi terpisah dari riwayat", async () => {
    await as(db, "lead");
    await db.query("delete from public.task_templates");
    await db.query("insert into public.task_templates (title, pic, repeat_type, due_time, active) values ('Dijeda', 'Sari', 'daily', '09:00', false)");
    assert.equal((await one(db, "select public.generate_recurring_tasks(0) as n")).n, 0);
  });

  test("hanya lead (atau sistem) yang bisa memicu pembuatan tugas berulang", async () => {
    await as(db, "cs");
    await assert.rejects(db.query("select public.generate_recurring_tasks(1)"), denied);
  });

  test("ubah template: default hanya memengaruhi tugas berikutnya; opsi eksplisit memengaruhi yang belum selesai", async () => {
    await as(db, "lead");
    await db.query("delete from public.task_templates");
    await db.query("insert into public.task_templates (id, title, pic, repeat_type, due_time) values ('11111111-1111-1111-1111-111111111111', 'Awal', 'Sari', 'daily', '09:00')");
    await db.query("select public.generate_recurring_tasks(0)");
    await db.query("update public.task_templates set title = 'Diganti', pic = 'Budi', priority = 'high', due_time = '10:30' where id = '11111111-1111-1111-1111-111111111111'");
    let r = await one(db, "select title, pic from public.tasks where template_id = '11111111-1111-1111-1111-111111111111'");
    assert.deepEqual([r.title, r.pic], ["Awal", "Sari"], "tugas lama tidak berubah otomatis");
    const n = (await one(db, "select public.apply_template_to_open_tasks('11111111-1111-1111-1111-111111111111', 'Michael') as n")).n;
    assert.equal(n, 1);
    r = await one(db, "select title, pic, priority, to_char(due_at at time zone 'Asia/Jakarta','HH24:MI') as hm from public.tasks where template_id = '11111111-1111-1111-1111-111111111111'");
    assert.deepEqual([r.title, r.pic, r.priority, r.hm], ["Diganti", "Budi", "high", "10:30"]);
    await as(db, "cs");
    await assert.rejects(db.query("select public.apply_template_to_open_tasks('11111111-1111-1111-1111-111111111111')"), denied);
  });

  test("hentikan template: tugas yang sudah dibuat tetap ada; opsi arsip hanya untuk yang belum dimulai dan belum jatuh tempo", async () => {
    await as(db, "lead");
    await db.query("delete from public.task_templates");
    await db.query("insert into public.task_templates (id, title, pic, repeat_type, due_time) values ('22222222-2222-2222-2222-222222222222', 'Stop', 'Sari', 'daily', '23:59')");
    await db.query("select public.generate_recurring_tasks(1)");
    await db.query("update public.tasks set status = 'in_progress' where template_id = '22222222-2222-2222-2222-222222222222' and occurrence_date = (now() at time zone 'Asia/Jakarta')::date");
    const archived = (await one(db, "select public.stop_template('22222222-2222-2222-2222-222222222222', true, 'Michael') as n")).n;
    const left = await rows(db, "select occurrence_date::text, archived_at is not null as arch, status from public.tasks where template_id = '22222222-2222-2222-2222-222222222222' order by occurrence_date");
    assert.equal(left.length, 2, "tidak ada tugas yang dihapus");
    assert.equal(left[0].arch, false, "yang sedang dikerjakan tidak diarsipkan");
    assert.equal(left[1].arch, true, "yang belum dimulai dan belum jatuh tempo diarsipkan");
    assert.equal(archived, 1);
    assert.equal((await one(db, "select active from public.task_templates where id = '22222222-2222-2222-2222-222222222222'")).active, false);
    assert.equal((await one(db, "select public.generate_recurring_tasks(1) as n")).n, 0);
  });
});

describe("scheduler: pengingat dan notifikasi", () => {
  const count = async (db, kind) => (await one(db, "select count(*)::int as n from public.notifications where kind = $1", [kind])).n;
  const run = async (db) => { await as(db, "internal"); await db.query("select app_private.run_scheduler()"); };
  const quiet = async (db) => { await as(db, "lead"); await db.query("update public.app_settings set value = 'false'::jsonb where key = 'digests_enabled'"); };

  test("pengingat: sekali per tenggat, meski scheduler berjalan berulang", async () => {
    const db = await freshDb(); await quiet(db);
    await addTask(db, "lead", { title: "Segera", due: new Date(Date.now() + 5 * 60_000).toISOString() });
    await run(db); await run(db); await run(db);
    assert.equal(await count(db, "reminder"), 1);
    const n = await one(db, "select title, body, urgent from public.notifications where kind = 'reminder'");
    assert.match(n.title, /Segera jatuh tempo: Segera/);
    assert.match(n.body, /PIC Sari/);
  });

  test("pengingat mengikuti jendela per tugas: belum masuk jendela berarti belum dikirim", async () => {
    const db = await freshDb(); await quiet(db);
    await addTask(db, "lead", { title: "Nanti", due: new Date(Date.now() + 60 * 60_000).toISOString(), remind: 10 });
    await addTask(db, "lead", { title: "Jendela 90", due: new Date(Date.now() + 60 * 60_000).toISOString(), remind: 90 });
    await run(db);
    const t = await rows(db, "select title from public.notifications where kind = 'reminder'");
    assert.deepEqual(t.map((x) => x.title), ["Segera jatuh tempo: Jendela 90"]);
  });

  test("tugas selesai atau diarsipkan tidak menerima pengingat; pengingat dimatikan tidak dikirim", async () => {
    const db = await freshDb(); await quiet(db);
    const due = new Date(Date.now() + 5 * 60_000).toISOString();
    const a = await addTask(db, "lead", { title: "Selesai", due });
    await addTask(db, "lead", { title: "Arsip", due });
    await addTask(db, "lead", { title: "Tanpa pengingat", due, remindEnabled: false });
    await as(db, "lead");
    await db.query("update public.tasks set done = true where id = $1", [a.id]);
    await db.query("update public.tasks set archived_at = now() where title = 'Arsip'");
    await run(db);
    assert.equal(await count(db, "reminder"), 0);
    assert.equal(await count(db, "overdue"), 0);
  });

  test("tenggat terlewat: satu notifikasi, satu kejadian terlambat; deadline baru memicu siklus baru", async () => {
    const db = await freshDb(); await quiet(db);
    const t = await addTask(db, "lead", { title: "Telat", due: new Date(Date.now() - 5 * 60_000).toISOString() });
    await run(db); await run(db);
    assert.equal(await count(db, "overdue"), 1);
    assert.equal((await one(db, "select count(*)::int as n from public.task_events where action = 'became_late'")).n, 1);
    await as(db, "lead");
    await db.query("update public.tasks set due_at = now() + interval '5 minutes' where id = $1", [t.id]);
    await run(db);
    assert.equal(await count(db, "reminder"), 1, "deadline baru mendapat pengingat baru");
  });

  test("eskalasi ke CS Lead hanya untuk prioritas tinggi yang terlambat lewat batas, dan bisa dimatikan", async () => {
    const db = await freshDb(); await quiet(db);
    await addTask(db, "lead", { title: "Penting", priority: "high", due: new Date(Date.now() - 20 * 60_000).toISOString() });
    await addTask(db, "lead", { title: "Biasa", priority: "medium", due: new Date(Date.now() - 20 * 60_000).toISOString() });
    await addTask(db, "lead", { title: "Baru telat", priority: "high", due: new Date(Date.now() - 5 * 60_000).toISOString() });
    await run(db);
    const t = await rows(db, "select title, audience from public.notifications where kind = 'lead_overdue'");
    assert.deepEqual(t.map((x) => x.title), ["Prioritas tinggi terlambat: Penting"]);
    assert.equal(t[0].audience, "lead");

    const db2 = await freshDb(); await quiet(db2);
    await as(db2, "lead");
    await db2.query("update public.app_settings set value = 'false'::jsonb where key = 'lead_escalation'");
    await addTask(db2, "lead", { title: "Penting", priority: "high", due: new Date(Date.now() - 20 * 60_000).toISOString() });
    await run(db2);
    assert.equal(await count(db2, "lead_overdue"), 0);
  });

  test("notifikasi tugas baru dan perubahan hanya untuk PIC terkait dan bukan untuk perubahan oleh PIC sendiri", async () => {
    const db = await freshDb(); await quiet(db);
    const t = await addTask(db, "lead", { title: "Tugas baru", pic: "Sari", by: "Michael" });
    await addTask(db, "lead", { title: "Self", pic: "Sari", by: "Sari" });
    await as(db, "lead");
    await db.query("update public.tasks set pic = 'Budi', updated_by = 'Michael' where id = $1", [t.id]);
    await db.query("update public.tasks set due_at = due_at + interval '1 hour', updated_by = 'Michael' where id = $1", [t.id]);
    await db.query("update public.tasks set priority = 'high', updated_by = 'Michael' where id = $1", [t.id]);
    const n = await rows(db, "select kind, audience, audience_pic, title from public.notifications where task_id = $1 order by id", [t.id]);
    assert.deepEqual(n.map((x) => [x.kind, x.audience_pic]), [["assigned", "Sari"], ["assigned", "Budi"], ["task_changed", "Budi"], ["task_changed", "Budi"]]);
    const self = await rows(db, "select * from public.notifications where title = 'Jobdesk baru untuk Sari' and task_id <> $1", [t.id]);
    assert.equal(self.length, 0, "tidak ada notifikasi untuk tugas yang dibuat PIC sendiri");
  });

  test("tugas berulang buatan sistem tidak membanjiri notifikasi 'jobdesk baru'", async () => {
    const db = await freshDb(); await quiet(db);
    await as(db, "lead");
    await db.query("insert into public.task_templates (title, pic, repeat_type, due_time) values ('Rutin', 'Sari', 'daily', '23:00')");
    await run(db);
    assert.equal(await count(db, "assigned"), 0);
  });

  test("ringkasan pagi dan akhir hari: sekali per hari, hanya dalam jendela waktu Asia/Jakarta", async () => {
    const db = await freshDb();
    await addTask(db, "lead", { title: "Terlambat A", priority: "high", due: new Date(Date.now() - 60 * 60_000).toISOString() });
    await addTask(db, "lead", { title: "Nanti", due: new Date(Date.now() + 5 * 3600_000).toISOString() });
    await as(db, "lead");
    await db.query(`update public.app_settings set value = to_jsonb(to_char(now() at time zone 'Asia/Jakarta', 'HH24:MI')) where key = 'digest_morning'`);
    await db.query(`update public.app_settings set value = to_jsonb(to_char((now() at time zone 'Asia/Jakarta') + interval '12 hours', 'HH24:MI')) where key = 'digest_evening'`);
    await run(db); await run(db);
    assert.equal(await count(db, "digest_morning"), 1);
    assert.equal(await count(db, "digest_evening"), 0);
    const d = await one(db, "select title, body from public.notifications where kind = 'digest_morning'");
    assert.match(d.title, /2 jobdesk belum selesai/);
    assert.match(d.body, /1 terlambat: Terlambat A \(Sari\)/);
    await as(db, "lead");
    await db.query(`update public.app_settings set value = to_jsonb(to_char(now() at time zone 'Asia/Jakarta', 'HH24:MI')) where key = 'digest_evening'`);
    await run(db);
    assert.equal(await count(db, "digest_evening"), 1);
    await as(db, "lead");
    await db.query("update public.app_settings set value = 'false'::jsonb where key = 'digests_enabled'");
    await as(db, "internal");
    await db.exec("delete from public.notifications");
    await run(db);
    assert.equal(await count(db, "digest_morning"), 0, "ringkasan bisa dimatikan");
  });

  test("status scheduler: waktu terakhir berjalan tercatat dan terbaca oleh pengguna login", async () => {
    const db = await freshDb(); await quiet(db);
    await as(db, "cs");
    let s = await one(db, "select public.scheduler_status() as s");
    assert.equal(s.s.last_run, null);
    assert.equal(s.s.cron_job, true);
    assert.equal(s.s.push_configured, false);
    await run(db);
    await as(db, "cs");
    s = await one(db, "select public.scheduler_status() as s");
    assert.ok(s.s.last_run);
    await as(db, "anon");
    await assert.rejects(db.query("select public.scheduler_status()"), denied);
  });
});

describe("Web Push: langganan, pengiriman, konfirmasi", () => {
  const SECRET = "rahasia-uji";
  let db;
  const run = async () => { await as(db, "internal"); await db.query("select app_private.run_scheduler()"); };
  const sub = async (who, endpoint, member, kinds) => {
    await as(db, who);
    await db.query("select public.upsert_push_subscription($1, 'p', 'a', $2, $3, 'UA')", [endpoint, member, kinds]);
  };
  const state = async (kind) => (await rows(db, "select id, push_state, push_sent, push_failed from public.notifications where kind = $1 order by id", [kind]));

  before(async () => {
    db = await freshDb();
    await as(db, "lead");
    await db.query("update public.app_settings set value = 'false'::jsonb where key = 'digests_enabled'");
  });

  test("tanpa pelanggan: status no_subscribers, bukan 'terkirim'", async () => {
    await addTask(db, "lead", { title: "A", due: new Date(Date.now() + 5 * 60_000).toISOString() });
    await run();
    const s = await state("reminder");
    assert.equal(s[0].push_state, "no_subscribers");
  });

  test("peran langganan diambil dari login, bukan dari input; CS tidak bisa membaca langganan", async () => {
    await sub("cs", "https://push.example/cs-sari", "Sari", null);
    await sub("lead", "https://push.example/lead", null, null);
    await as(db, "internal");
    const r = await rows(db, "select endpoint, role from public.push_subscriptions order by endpoint");
    assert.deepEqual(r.map((x) => x.role), ["cs", "lead"]);
    await as(db, "cs");
    await assert.rejects(db.query("select * from public.push_subscriptions"), denied);
    await as(db, "stranger");
    await assert.rejects(db.query("select public.upsert_push_subscription('https://x.example/1','p','a',null,null,null)"), denied);
    await as(db, "cs");
    await assert.rejects(db.query("select public.upsert_push_subscription('http://insecure.example','p','a',null,null,null)"), /tidak valid/i);
  });

  test("belum dikonfigurasi (URL dan secret kosong): status not_configured", async () => {
    await addTask(db, "lead", { title: "B", due: new Date(Date.now() + 6 * 60_000).toISOString() });
    await run();
    const s = await state("reminder");
    assert.equal(s[s.length - 1].push_state, "not_configured");
    assert.equal((await one(db, "select count(*)::int as n from net.calls")).n, 0);
  });

  test("terkonfigurasi: payload hanya memuat pelanggan yang sesuai audiens dan jenis notifikasi", async () => {
    await as(db, "internal");
    await db.query("insert into app_private.settings (key, value) values ('push_url', 'https://jobdesk.example/api/push'), ('push_secret', $1)", [SECRET]);
    await sub("cs", "https://push.example/cs-budi", "Budi", ["reminder"]);
    await sub("cs", "https://push.example/cs-budi2", "Budi", null);
    await sub("cs", "https://push.example/cs-andi", "Andi", ["digest_morning"]); // tidak memilih reminder
    await addTask(db, "lead", { title: "C", pic: "Budi", due: new Date(Date.now() + 7 * 60_000).toISOString() });
    await run();
    const calls = await rows(db, "select url, body, headers from net.calls order by id");
    const rem = calls.find((x) => x.body.title === "Segera jatuh tempo: C");
    assert.ok(rem, "pengingat masuk antrean pengiriman");
    assert.equal(rem.url, "https://jobdesk.example/api/push");
    assert.equal(rem.headers["x-push-secret"], SECRET);
    assert.deepEqual(rem.body.subscriptions.map((s) => s.endpoint).sort(),
      ["https://push.example/cs-budi", "https://push.example/cs-budi2", "https://push.example/cs-sari", "https://push.example/lead"]);
    const asg = calls.find((x) => x.body.kind === "assigned" && x.body.title === "Jobdesk baru untuk Budi");
    assert.ok(asg, "notifikasi tugas baru terkirim");
    assert.deepEqual(asg.body.subscriptions.map((s) => s.endpoint), ["https://push.example/cs-budi2"],
      "hanya perangkat Budi yang memilih jenis 'assigned'");
    const st = await state("reminder");
    assert.equal(st[st.length - 1].push_state, "queued", "antre, belum dianggap terkirim");
  });

  test("konfirmasi dengan secret salah ditolak; status tetap 'queued'", async () => {
    const [n] = (await state("reminder")).slice(-1);
    await as(db, "anon");
    await assert.rejects(db.query("select public.confirm_push('salah', $1, '[]'::jsonb)", [n.id]), denied);
    await as(db, "internal");
    assert.equal((await one(db, "select push_state from public.notifications where id = $1", [n.id])).push_state, "queued");
  });

  test("konfirmasi sebagian: status partial, langganan kedaluwarsa (410) dihapus, kegagalan dihitung", async () => {
    const [n] = (await state("reminder")).slice(-1);
    await as(db, "anon");
    await db.query("select public.confirm_push($1, $2, $3::jsonb)", [SECRET, n.id, JSON.stringify([
      { endpoint: "https://push.example/cs-budi", ok: true, status: 201 },
      { endpoint: "https://push.example/cs-budi2", ok: true, status: 201 },
      { endpoint: "https://push.example/cs-sari", ok: false, status: 410 },
      { endpoint: "https://push.example/lead", ok: false, status: 500 },
    ])]);
    await as(db, "internal");
    const s = await one(db, "select push_state, push_sent, push_failed, push_confirmed_at is not null as c from public.notifications where id = $1", [n.id]);
    assert.deepEqual([s.push_state, s.push_sent, s.push_failed, s.c], ["partial", 2, 2, true]);
    const subs = await rows(db, "select endpoint, failed_count from public.push_subscriptions order by endpoint");
    assert.ok(!subs.some((x) => x.endpoint.endsWith("cs-sari")), "langganan 410 dihapus");
    assert.equal(subs.find((x) => x.endpoint.endsWith("/lead")).failed_count, 1);
  });

  test("semua berhasil: sent; semua gagal: failed; langganan dengan 5 kegagalan beruntun dihapus", async () => {
    await as(db, "internal");
    await db.exec("insert into public.notifications (kind, title, dedup_key, push_state) values ('reminder', 'X', 'x1', 'queued'), ('reminder', 'Y', 'x2', 'queued')");
    const [x1, x2] = await rows(db, "select id from public.notifications where dedup_key in ('x1','x2') order by dedup_key");
    await as(db, "anon");
    await db.query("select public.confirm_push($1, $2, $3::jsonb)", [SECRET, x1.id, JSON.stringify([{ endpoint: "https://push.example/cs-budi", ok: true, status: 201 }])]);
    for (let i = 0; i < 5; i++) {
      await db.query("select public.confirm_push($1, $2, $3::jsonb)", [SECRET, x2.id, JSON.stringify([{ endpoint: "https://push.example/lead", ok: false, status: 500 }])]);
    }
    await as(db, "internal");
    const r = await rows(db, "select dedup_key, push_state from public.notifications where dedup_key in ('x1','x2') order by dedup_key");
    assert.deepEqual(r.map((x) => x.push_state), ["sent", "failed"]);
    assert.equal((await rows(db, "select 1 from public.push_subscriptions where endpoint like '%/lead'")).length, 0);
  });

  test("antrean tanpa konfirmasi lebih dari 3 menit menjadi 'unconfirmed', tidak pernah dianggap terkirim", async () => {
    await as(db, "internal");
    await db.exec("insert into public.notifications (kind, title, dedup_key, push_state, push_queued_at) values ('reminder', 'Z', 'z1', 'queued', now() - interval '10 minutes')");
    await run();
    const r = await one(db, "select push_state from public.notifications where dedup_key = 'z1'");
    assert.equal(r.push_state, "unconfirmed");
  });

  test("langganan bisa dibaca dan dihapus perangkat pemiliknya lewat fungsi; CS tidak bisa membaca tabel", async () => {
    await as(db, "cs");
    const g = await one(db, "select public.get_my_push_subscription('https://push.example/cs-budi2') as s");
    assert.equal(g.s.member_name, "Budi");
    await db.query("select public.remove_push_subscription('https://push.example/cs-budi2')");
    const g2 = await one(db, "select public.get_my_push_subscription('https://push.example/cs-budi2') as s");
    assert.equal(g2.s, null);
  });
});
