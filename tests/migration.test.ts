// Migrasi dari skema lama (commit 19a0646) dengan data nyata: tidak boleh ada data hilang.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb, newSchemaSql, oldSchemaSql, rows } from "./helpers/pg";

interface TaskRow {
  title: string; pic: string; status: string; done: boolean; done_at: string | null;
  original_due_at: string | null; due_at: string; original_pic: string | null;
  template_id: string | null; occurrence_date: string | null; priority: string; archived_at: string | null;
  remind_enabled: boolean; remind_before_min: number;
}

describe("migrasi dari skema lama", () => {
  let db: PGlite;
  let before_: { id: string; title: string; pic: string; due_at: string; done: boolean; note: string }[];

  before(async () => {
    db = await freshDb();
    await db.exec(oldSchemaSql());
    await db.exec(`
      insert into team_members (name, absent_on) values ('Ani', null), ('Budi', '2026-01-01');
      insert into tasks (title, pic, due_at, repeat, done, done_at, note) values
        ('Selesai lama', 'Ani', now() - interval '2 days', 'none', true, now() - interval '1 day', 'catatan lama'),
        ('Rekap harian', 'Budi', now() + interval '3 hours', 'daily', false, null, ''),
        ('Cek komentar', 'Ani', now() + interval '1 day', 'weekdays', false, null, null),
        ('Sekali saja', 'Ani', now() + interval '5 hours', 'none', false, null, 'x');
    `);
    before_ = await rows(db, "select id, title, pic, due_at, done, note from tasks order by title");
    await db.exec(newSchemaSql());
  });

  it("tidak ada jobdesk atau anggota yang hilang, isi lama tidak berubah", async () => {
    const after = await rows<{ id: string; title: string; pic: string; due_at: string; done: boolean; note: string }>(
      db, "select id, title, pic, due_at, done, note from tasks order by title");
    assert.deepEqual(after, before_);
    const members = await rows<{ name: string; absent_on: string | null }>(db, "select name, absent_on from team_members order by name");
    assert.deepEqual(members, [{ name: "Ani", absent_on: null }, { name: "Budi", absent_on: "2026-01-01" }]);
  });

  it("kolom baru terisi dari data lama", async () => {
    const t = await rows<TaskRow>(db, "select * from tasks order by title");
    const lama = t.find((x) => x.title === "Selesai lama")!;
    assert.equal(lama.status, "done");
    assert.ok(lama.done_at, "waktu selesai lama dipertahankan");
    for (const x of t) {
      assert.equal(x.original_pic, x.pic);
      assert.ok(x.original_due_at, "deadline awal terisi");
      assert.equal(x.priority, "medium");
      assert.equal(x.archived_at, null);
      assert.equal(x.remind_enabled, true);
      assert.equal(x.remind_before_min, 10);
    }
    assert.equal(t.find((x) => x.title === "Sekali saja")!.status, "todo");
  });

  it("jobdesk berulang lama berpindah menjadi template, sekali saja", async () => {
    const tpl = await rows<{ title: string; repeat_type: string; pic: string; due_time: string }>(
      db, "select title, repeat_type, pic, due_time::text from task_templates order by title");
    assert.deepEqual(tpl.map((x) => [x.title, x.repeat_type, x.pic]), [
      ["Cek komentar", "weekdays", "Ani"],
      ["Rekap harian", "daily", "Budi"],
    ]);
    const linked = await rows<{ title: string; template_id: string | null; occurrence_date: string | null }>(
      db, "select title, template_id, occurrence_date::text from tasks where title in ('Cek komentar','Rekap harian')");
    for (const l of linked) {
      assert.ok(l.template_id && l.occurrence_date, `${l.title} terhubung ke template`);
    }
    assert.equal((await rows(db, "select 1 from tasks where title = 'Sekali saja' and template_id is not null")).length, 0);
  });

  it("menjalankan skema lagi tidak mengubah apa pun (idempoten)", async () => {
    const snapshot = async () => ({
      tasks: await rows(db, "select id, title, pic, status, template_id, occurrence_date::text from tasks order by id"),
      templates: await rows(db, "select title, repeat_type from task_templates order by title"),
      roles: await rows(db, "select email, role from app_roles order by email"),
      settings: await rows(db, "select key, value from app_settings order by key"),
      events: (await rows<{ n: string }>(db, "select count(*)::text n from task_events"))[0].n,
    });
    const a = await snapshot();
    await db.exec(newSchemaSql());
    await db.exec(newSchemaSql());
    assert.deepEqual(await snapshot(), a);
  });

  it("kebijakan lama 'tim bersama' sudah diganti dan RLS aktif di semua tabel", async () => {
    const old = await rows(db, "select 1 from pg_policies where policyname = 'tim bersama'");
    assert.equal(old.length, 0);
    const rls = await rows<{ relname: string; relrowsecurity: boolean }>(
      db, `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and relkind = 'r' order by relname`);
    for (const r of rls) assert.equal(r.relrowsecurity, true, `RLS aktif di ${r.relname}`);
    assert.ok(rls.length >= 8);
  });

  it("tidak ada kebijakan DELETE pada jobdesk, riwayat, dan notifikasi", async () => {
    const pol = await rows<{ tablename: string; cmd: string }>(
      db, "select tablename, cmd from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL')");
    const tables = pol.map((p) => `${p.tablename}:${p.cmd}`);
    assert.ok(!tables.some((t) => t.startsWith("tasks:") || t.startsWith("task_events:") || t.startsWith("notifications:")), tables.join(","));
  });
});
