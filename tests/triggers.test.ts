// Status, waktu penyelesaian, riwayat deadline/PIC, dan timeline aktivitas.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, CS, failsWith, freshDb, LEAD, newSchemaSql, rows } from "./helpers/pg";

interface Ev { action: string; actor: string; old_value: string | null; new_value: string | null; meta: Record<string, unknown>; task_title: string }
interface T { id: string; status: string; done: boolean; done_at: string | null; started_at: string | null; due_at: string; original_due_at: string; pic: string; original_pic: string; template_id: string | null; created_at: string }

describe("trigger jobdesk dan riwayat aktivitas", () => {
  let db: PGlite;
  const events = (id: string) => rows<Ev>(db, "select action, actor, old_value, new_value, meta, task_title from task_events where task_id = $1 order by id", [id]);
  const get = async (id: string) => (await rows<T>(db, "select * from tasks where id = $1", [id]))[0];
  const make = async (title = "Uji", extra = "") =>
    asUser(db, LEAD, async () =>
      (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at, updated_by ${extra ? "," + extra.split("=")[0] : ""}) values ($1, 'Ani', now() + interval '4 hours', 'CS Lead' ${extra ? "," + extra.split("=")[1] : ""}) returning id`, [title]))[0].id);

  before(async () => {
    db = await freshDb();
    await db.exec(newSchemaSql());
    await db.exec("insert into team_members (name) values ('Ani'), ('Budi'), ('Lead');");
  });

  it("membuat jobdesk: tercatat 'created', deadline dan PIC awal disimpan", async () => {
    const id = await make("Pertama");
    const t = await get(id);
    assert.equal(t.original_pic, "Ani");
    assert.equal(t.original_due_at, t.due_at);
    assert.equal(t.status, "todo");
    const ev = await events(id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].action, "created");
    assert.equal(ev[0].actor, "CS Lead");
    assert.equal(ev[0].task_title, "Pertama");
  });

  it("klien tidak bisa memalsukan waktu selesai, deadline awal, atau waktu dibuat", async () => {
    const id = await asUser(db, LEAD, async () =>
      (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at, original_due_at, original_pic, done, done_at, created_at)
        values ('Palsu', 'Ani', now() + interval '1 hour', '2000-01-01', 'Orang Lain', true, '2000-01-01', '2000-01-01') returning id`))[0].id);
    const t = await get(id);
    assert.equal(t.status, "done");
    assert.ok(Math.abs(Date.parse(t.done_at as string) - Date.now()) < 60_000, "done_at memakai jam server");
    assert.equal(t.original_due_at, t.due_at);
    assert.equal(t.original_pic, "Ani");
    await asUser(db, LEAD, () => db.query("update tasks set created_at = '2000-01-01', original_due_at = '2000-01-01', original_pic = 'X', done_at = '2000-01-01' where id = $1", [id]));
    const u = await get(id);
    assert.equal(u.original_pic, "Ani");
    assert.equal(u.original_due_at, u.due_at);
    assert.ok(Date.parse(u.created_at) > Date.parse("2020-01-01"));
    assert.equal(u.done_at, t.done_at, "waktu selesai tidak bisa digeser");
  });

  it("Dalam Proses mengisi waktu mulai dan mencatat perubahan status", async () => {
    const id = await make("Proses");
    await asUser(db, CS, () => db.query("update tasks set status = 'in_progress', updated_by = 'Tim CS' where id = $1", [id]));
    const t = await get(id);
    assert.equal(t.status, "in_progress");
    assert.ok(t.started_at);
    const ev = (await events(id)).find((e) => e.action === "status_changed")!;
    assert.deepEqual([ev.old_value, ev.new_value, ev.actor], ["todo", "in_progress", "Tim CS"]);
    // pindah ke Menunggu tidak menghapus waktu mulai
    await asUser(db, CS, () => db.query("update tasks set status = 'waiting' where id = $1", [id]));
    assert.equal((await get(id)).started_at, t.started_at);
  });

  it("deadline lewat tidak mengubah status menjadi selesai", async () => {
    const id = await asUser(db, LEAD, async () =>
      (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at, status) values ('Lewat', 'Ani', now() - interval '3 hours', 'in_progress') returning id`))[0].id);
    const t = await get(id);
    assert.equal(t.status, "in_progress");
    assert.equal(t.done, false);
    assert.equal(t.done_at, null);
  });

  it("menyelesaikan: waktu selesai aktual dari server, tercatat 'completed' (tepat waktu)", async () => {
    const id = await make("Selesai");
    await asUser(db, CS, () => db.query("update tasks set done = true, updated_by = 'Tim CS' where id = $1", [id]));
    const t = await get(id);
    assert.equal(t.status, "done");
    assert.equal(t.done, true);
    assert.ok(Math.abs(Date.parse(t.done_at as string) - Date.now()) < 60_000);
    const ev = (await events(id)).find((e) => e.action === "completed")!;
    assert.equal(ev.meta.late, false);
    // mengubah hal lain saat sudah selesai tidak menggeser waktu selesai
    await asUser(db, LEAD, () => db.query("update tasks set note = 'tambahan' where id = $1", [id]));
    assert.equal((await get(id)).done_at, t.done_at);
  });

  it("menyelesaikan lewat status 'done' sama dengan mencentang", async () => {
    const id = await make("Lewat status");
    await asUser(db, CS, () => db.query("update tasks set status = 'done' where id = $1", [id]));
    const t = await get(id);
    assert.equal(t.done, true);
    assert.ok(t.done_at);
  });

  it("selesai setelah deadline ditandai terlambat di riwayat", async () => {
    const id = await asUser(db, LEAD, async () =>
      (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at) values ('Telat', 'Ani', now() - interval '2 hours') returning id`))[0].id);
    await asUser(db, CS, () => db.query("update tasks set done = true where id = $1", [id]));
    const ev = (await events(id)).find((e) => e.action === "completed")!;
    assert.equal(ev.meta.late, true);
  });

  it("membuka kembali: status kembali 'todo', waktu selesai dihapus, tercatat di riwayat", async () => {
    const id = await make("Buka lagi");
    await asUser(db, CS, () => db.query("update tasks set done = true where id = $1", [id]));
    await asUser(db, LEAD, () => db.query("update tasks set done = false, updated_by = 'CS Lead' where id = $1", [id]));
    const t = await get(id);
    assert.equal(t.done, false);
    assert.equal(t.status, "todo");
    assert.equal(t.done_at, null);
    const actions = (await events(id)).map((e) => e.action);
    assert.deepEqual(actions, ["created", "completed", "reopened"]);
  });

  it("mengganti PIC, deadline, dan prioritas: riwayat lama tetap, nilai lama dan baru tersimpan", async () => {
    const id = await make("Ubah-ubah");
    const before = await get(id);
    await asUser(db, LEAD, () => db.query(
      "update tasks set pic = 'Budi', due_at = due_at + interval '2 hours', priority = 'high', updated_by = 'CS Lead' where id = $1", [id]));
    const t = await get(id);
    assert.equal(t.pic, "Budi");
    assert.equal(t.original_pic, "Ani", "PIC awal tidak berubah");
    assert.equal(t.original_due_at, before.due_at, "deadline awal tidak berubah");
    assert.notEqual(t.due_at, before.due_at);
    const ev = await events(id);
    const by = (a: string) => ev.find((e) => e.action === a)!;
    assert.deepEqual([by("pic_changed").old_value, by("pic_changed").new_value], ["Ani", "Budi"]);
    assert.deepEqual([by("priority_changed").old_value, by("priority_changed").new_value], ["medium", "high"]);
    assert.match(by("due_changed").old_value as string, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    assert.notEqual(by("due_changed").old_value, by("due_changed").new_value);
    // perubahan kedua menambah riwayat, tidak menimpa
    await asUser(db, LEAD, () => db.query("update tasks set pic = 'Ani' where id = $1", [id]));
    assert.equal((await events(id)).filter((e) => e.action === "pic_changed").length, 2);
  });

  it("memperbarui tanpa mengubah apa pun tidak menambah riwayat", async () => {
    const id = await make("Diam");
    const n = (await events(id)).length;
    await asUser(db, LEAD, () => db.query("update tasks set title = title where id = $1", [id]));
    assert.equal((await events(id)).length, n);
  });

  it("alasan keterlambatan tercatat bersama pengguna dan catatannya", async () => {
    const id = await make("Alasan");
    await asUser(db, CS, () => db.query("update tasks set late_reason = 'high_workload', late_note = 'banyak tiket', updated_by = 'Tim CS' where id = $1", [id]));
    const ev = (await events(id)).find((e) => e.action === "late_reason_set")!;
    assert.equal(ev.new_value, "high_workload");
    assert.equal(ev.meta.note, "banyak tiket");
    assert.equal(ev.actor, "Tim CS");
    assert.equal(await asUser(db, CS, () => failsWith(db, "update tasks set late_reason = 'ngarang' where id = $1", [id])), "23514");
  });

  it("arsip dan pemulihan tercatat, jobdesk tidak benar-benar hilang", async () => {
    const id = await make("Arsip");
    await asUser(db, LEAD, () => db.query("update tasks set archived_at = now() where id = $1", [id]));
    await asUser(db, LEAD, () => db.query("update tasks set archived_at = null where id = $1", [id]));
    assert.deepEqual((await events(id)).map((e) => e.action), ["created", "archived", "restored"]);
    assert.equal((await rows(db, "select 1 from tasks where id = $1", [id])).length, 1);
  });

  it("riwayat tetap ada setelah jobdesk diarsipkan dan tidak bisa diubah klien", async () => {
    const id = await make("Riwayat kekal");
    await asUser(db, LEAD, async () => {
      assert.equal(await failsWith(db, "update task_events set actor = 'palsu'"), "42501");
      assert.equal(await failsWith(db, "delete from task_events"), "42501");
    });
    assert.ok((await events(id)).length >= 1);
  });

  it("batas isi data ditegakkan database", async () => {
    const bad = (cols: string, vals: string) =>
      asUser(db, LEAD, () => failsWith(db, `insert into tasks (title, pic, due_at ${cols}) values ${vals}`));
    assert.equal(await bad("", `('${"x".repeat(121)}', 'Ani', now())`), "23514");
    assert.equal(await bad("", `('   ', 'Ani', now())`), "23514");
    assert.equal(await bad(", remind_before_min", `('ok', 'Ani', now(), 0)`), "23514");
    assert.equal(await bad(", remind_before_min", `('ok', 'Ani', now(), 5000)`), "23514");
    assert.equal(await bad(", priority", `('ok', 'Ani', now(), 'urgent')`), "23514");
    assert.equal(await bad(", status", `('ok', 'Ani', now(), 'selesai')`), "23514");
    assert.equal(await bad(", note", `('ok', 'Ani', now(), '${"n".repeat(1001)}')`), "23514");
    assert.equal(await bad("", `('ok', 'Ani', now())`), null);
  });

  it("jobdesk baru untuk PIC membuat notifikasi 'assigned', pengalihan PIC juga", async () => {
    const id = await make("Tugas baru");
    const n1 = await rows<{ kind: string; audience: string; audience_pic: string; title: string }>(
      db, "select kind, audience, audience_pic, title from notifications where task_id = $1", [id]);
    assert.equal(n1.length, 1);
    assert.deepEqual([n1[0].kind, n1[0].audience, n1[0].audience_pic], ["assigned", "pic", "Ani"]);
    await asUser(db, LEAD, () => db.query("update tasks set pic = 'Budi', updated_by = 'CS Lead' where id = $1", [id]));
    const n2 = await rows<{ audience_pic: string }>(db, "select audience_pic from notifications where task_id = $1 and kind = 'assigned' order by id", [id]);
    assert.deepEqual(n2.map((r) => r.audience_pic), ["Ani", "Budi"]);
  });

  it("tidak ada notifikasi 'assigned' jika yang membuat adalah PIC itu sendiri", async () => {
    const id = await asUser(db, LEAD, async () =>
      (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at, updated_by) values ('Sendiri', 'Lead', now() + interval '1 hour', 'Lead') returning id`))[0].id);
    assert.equal((await rows(db, "select 1 from notifications where task_id = $1", [id])).length, 0);
  });

  it("perubahan deadline dan prioritas tinggi memberi tahu PIC", async () => {
    const id = await make("Dipantau");
    await asUser(db, LEAD, () => db.query("update tasks set due_at = due_at + interval '1 hour', priority = 'high', updated_by = 'CS Lead' where id = $1", [id]));
    const kinds = await rows<{ kind: string; urgent: boolean; title: string }>(db, "select kind, urgent, title from notifications where task_id = $1 and kind = 'task_changed' order by id", [id]);
    assert.equal(kinds.length, 2);
    assert.ok(kinds.some((k) => k.urgent && /Prioritas tinggi/.test(k.title)));
  });
});
