// Hak akses ditegakkan di database (RLS + trigger), bukan hanya disembunyikan di UI.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, CS, failsWith, freshDb, LEAD, newSchemaSql, OUTSIDER, rows } from "./helpers/pg";

const INSERT = `insert into tasks (title, pic, due_at, updated_by) values ($1, 'Ani', now() + interval '2 hours', 'uji') returning id`;

describe("hak akses per peran", () => {
  let db: PGlite;
  let taskId: string;

  before(async () => {
    db = await freshDb();
    await db.exec(newSchemaSql());
    await db.exec(`insert into team_members (name) values ('Ani'), ('Budi');`);
    taskId = (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at) values ('Awal', 'Ani', now() + interval '3 hours') returning id`))[0].id;
  });

  it("CS Lead boleh membuat, mengubah, dan mengarsipkan jobdesk, tidak boleh menghapus", async () => {
    const id = await asUser(db, LEAD, async () => (await rows<{ id: string }>(db, INSERT, ["Dari lead"]))[0].id);
    await asUser(db, LEAD, async () => {
      await db.query("update tasks set pic = 'Budi', priority = 'high' where id = $1", [id]);
      const t = (await rows<{ pic: string; priority: string }>(db, "select pic, priority from tasks where id = $1", [id]))[0];
      assert.deepEqual(t, { pic: "Budi", priority: "high" });
      await db.query("update tasks set archived_at = now() where id = $1", [id]);
      assert.equal((await rows(db, "select 1 from tasks where id = $1", [id])).length, 1, "lead tetap melihat arsip");
      assert.equal(await failsWith(db, "delete from tasks where id = $1", [id]), "42501");
    });
  });

  it("CS tidak boleh membuat jobdesk bila pengaturan 'CS boleh mengelola' mati", async () => {
    const code = await asUser(db, CS, () => failsWith(db, INSERT, ["Dari CS"]));
    assert.equal(code, "42501");
  });

  it("CS boleh mengubah status, waktu mulai, dan alasan keterlambatan, tidak yang lain", async () => {
    await asUser(db, CS, async () => {
      await db.query("update tasks set status = 'in_progress', updated_by = 'Tim CS' where id = $1", [taskId]);
      const t = (await rows<{ status: string; started_at: string | null }>(db, "select status, started_at from tasks where id = $1", [taskId]))[0];
      assert.equal(t.status, "in_progress");
      assert.ok(t.started_at, "waktu mulai terisi otomatis");
      await db.query("update tasks set late_reason = 'waiting_info', late_note = 'tunggu data' where id = $1", [taskId]);
    });
    for (const [col, val] of [["title", "'Diubah'"], ["pic", "'Budi'"], ["priority", "'high'"],
      ["due_at", "now() + interval '9 days'"], ["note", "'x'"], ["remind_before_min", "99"], ["archived_at", "now()"]]) {
      const code = await asUser(db, CS, () => failsWith(db, `update tasks set ${col} = ${val} where id = $1`, [taskId]));
      assert.equal(code, "42501", `CS tidak boleh mengubah ${col}`);
    }
    const t = (await rows<{ title: string; pic: string }>(db, "select title, pic from tasks where id = $1", [taskId]))[0];
    assert.deepEqual(t, { title: "Awal", pic: "Ani" });
  });

  it("CS tidak boleh menghapus jobdesk", async () => {
    assert.equal(await asUser(db, CS, () => failsWith(db, "delete from tasks where id = $1", [taskId])), "42501");
  });

  it("CS tidak melihat jobdesk yang diarsipkan, lead melihatnya", async () => {
    const id = (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at, archived_at) values ('Arsip', 'Ani', now(), now()) returning id`))[0].id;
    const cs = await asUser(db, CS, () => rows(db, "select 1 from tasks where id = $1", [id]));
    const lead = await asUser(db, LEAD, () => rows(db, "select 1 from tasks where id = $1", [id]));
    assert.equal(cs.length, 0);
    assert.equal(lead.length, 1);
  });

  it("CS tidak melihat jobdesk selesai lebih dari 14 hari lalu", async () => {
    const id = (await rows<{ id: string }>(db, `insert into tasks (title, pic, due_at) values ('Basi', 'Ani', now() - interval '40 days') returning id`))[0].id;
    await db.query("update tasks set done = true where id = $1", [id]);
    // Trigger selalu memakai jam server; matikan sebentar agar tercipta data selesai yang sudah lama.
    await db.exec(`alter table tasks disable trigger tasks_before_write; update tasks set done_at = now() - interval '30 days' where id = '${id}'; alter table tasks enable trigger tasks_before_write;`);
    assert.equal((await asUser(db, CS, () => rows(db, "select 1 from tasks where id = $1", [id]))).length, 0);
    assert.equal((await asUser(db, LEAD, () => rows(db, "select 1 from tasks where id = $1", [id]))).length, 1);
  });

  it("orang di luar daftar peran tidak bisa membaca atau menulis apa pun", async () => {
    await asUser(db, OUTSIDER, async () => {
      for (const t of ["tasks", "team_members", "task_events", "notifications", "app_settings", "task_templates"]) {
        assert.equal((await rows(db, `select 1 from ${t}`)).length, 0, `${t} kosong bagi orang luar`);
      }
      assert.equal(await failsWith(db, INSERT, ["x"]), "42501");
      assert.equal(await failsWith(db, "update tasks set status = 'done'"), null); // 0 baris terpengaruh, bukan error
      assert.equal(await failsWith(db, "select public.generate_recurring_tasks(1)"), "42501");
      assert.equal(await failsWith(db, "select public.scheduler_status()"), "42501");
    });
    const still = await rows<{ status: string }>(db, "select status from tasks where id = $1", [taskId]);
    assert.notEqual(still[0].status, "done");
  });

  it("pengguna anon tanpa login ditolak di semua tabel", async () => {
    await asUser(db, null, async () => {
      for (const t of ["tasks", "team_members", "task_templates", "task_events", "notifications", "app_settings", "app_roles", "push_subscriptions"]) {
        assert.equal(await failsWith(db, `select * from ${t}`), "42501", t);
      }
      assert.equal(await failsWith(db, "insert into tasks (title, pic, due_at) values ('x','y',now())"), "42501");
    });
  });

  it("tabel peran dan langganan push tidak bisa dibaca atau diubah klien", async () => {
    for (const email of [LEAD, CS]) {
      await asUser(db, email, async () => {
        assert.equal(await failsWith(db, "select * from app_roles"), "42501");
        assert.equal(await failsWith(db, "update app_roles set role = 'lead'"), "42501");
        assert.equal(await failsWith(db, "select * from push_subscriptions"), "42501");
        assert.equal(await failsWith(db, "insert into task_events (task_title, action, actor) values ('x','created','y')"), "42501");
        assert.equal(await failsWith(db, "insert into notifications (kind, title, dedup_key) values ('reminder','x','k')"), "42501");
      });
    }
  });

  it("CS tidak bisa menaikkan hak aksesnya lewat pengaturan, lead bisa", async () => {
    await asUser(db, CS, async () => {
      await db.query("update app_settings set value = 'true'::jsonb where key = 'cs_can_manage'");
      assert.equal(await failsWith(db, "insert into app_settings (key, value) values ('digests_enabled', 'false'::jsonb) on conflict (key) do update set value = excluded.value"), "42501");
    });
    assert.equal((await rows<{ value: boolean }>(db, "select value from app_settings where key = 'cs_can_manage'"))[0].value, false);
    await asUser(db, LEAD, () => db.query("update app_settings set value = 'true'::jsonb where key = 'cs_can_manage'"));
    assert.equal((await rows<{ value: boolean }>(db, "select value from app_settings where key = 'cs_can_manage'"))[0].value, true);
  });

  it("dengan 'CS boleh mengelola' menyala, CS boleh membuat dan mengubah jobdesk (tetap tanpa hapus)", async () => {
    const id = await asUser(db, CS, async () => (await rows<{ id: string }>(db, INSERT, ["CS dengan izin"]))[0].id);
    await asUser(db, CS, async () => {
      await db.query("update tasks set priority = 'low' where id = $1", [id]);
      assert.equal(await failsWith(db, "delete from tasks where id = $1", [id]), "42501");
    });
    await asUser(db, LEAD, () => db.query("update app_settings set value = 'false'::jsonb where key = 'cs_can_manage'"));
    assert.equal(await asUser(db, CS, () => failsWith(db, INSERT, ["lagi"])), "42501");
  });

  it("template hanya untuk CS Lead", async () => {
    const ins = `insert into task_templates (title, pic, repeat_type) values ('T', 'Ani', 'daily')`;
    assert.equal(await asUser(db, CS, () => failsWith(db, ins)), "42501");
    assert.equal(await asUser(db, LEAD, () => failsWith(db, ins)), null);
    assert.equal((await asUser(db, CS, () => rows(db, "select 1 from task_templates"))).length, 0);
    assert.equal((await asUser(db, LEAD, () => rows(db, "select 1 from task_templates"))).length, 1);
  });

  it("anggota tim: CS tidak bisa menambah/menandai, lead bisa; hanya lead boleh menghapus", async () => {
    assert.equal(await asUser(db, CS, () => failsWith(db, "insert into team_members (name) values ('Cici')")), "42501");
    assert.equal(await asUser(db, LEAD, () => failsWith(db, "insert into team_members (name) values ('Cici')")), null);
    await asUser(db, CS, () => db.query("update team_members set absent_on = '2030-01-01' where name = 'Cici'"));
    assert.equal((await rows<{ absent_on: string | null }>(db, "select absent_on from team_members where name = 'Cici'"))[0].absent_on, null);
    await asUser(db, CS, () => db.query("delete from team_members where name = 'Cici'"));
    assert.equal((await rows(db, "select 1 from team_members where name = 'Cici'")).length, 1, "CS tidak bisa menghapus");
    await asUser(db, LEAD, () => db.query("delete from team_members where name = 'Cici'"));
    assert.equal((await rows(db, "select 1 from team_members where name = 'Cici'")).length, 0);
  });

  it("my_role mengembalikan peran yang benar", async () => {
    const role = (email: string | null) => asUser(db, email, async () => (await rows<{ r: string | null }>(db, "select public.my_role() r"))[0].r);
    assert.equal(await role(LEAD), "lead");
    assert.equal(await role(CS), "cs");
    assert.equal(await role(OUTSIDER), null);
    assert.equal(await role(CS.toUpperCase()), "cs", "email tidak peka huruf besar-kecil");
  });
});
