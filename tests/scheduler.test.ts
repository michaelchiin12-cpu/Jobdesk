// Scheduler background: pengingat, tenggat lewat, eskalasi, ringkasan, dan antrean push. Semuanya idempoten.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, CS, failsWith, freshDb, LEAD, newSchemaSql, OUTSIDER, rows } from "./helpers/pg";

interface N { id: number; kind: string; task_id: string | null; audience: string; audience_pic: string | null; title: string; body: string; urgent: boolean; push_state: string; push_sent: number; push_failed: number }

async function setup(): Promise<PGlite> {
  const db = await freshDb();
  await db.exec(newSchemaSql());
  await db.exec("insert into team_members (name) values ('Ani'), ('Budi');");
  return db;
}

describe("scheduler: pengingat dan notifikasi", () => {
  let db: PGlite;
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => rows<T>(db, sql, p);
  const run = () => db.exec("select app_private.run_scheduler()");
  const task = async (title: string, due: string, cols = "", vals = "") =>
    (await q<{ id: string }>(`insert into tasks (title, pic, due_at ${cols}) values ($1, 'Ani', ${due} ${vals}) returning id`, [title]))[0].id;
  const notifs = (kind: string, id?: string) =>
    q<N>(`select * from notifications where kind = $1 ${id ? "and task_id = $2" : ""} order by id`, id ? [kind, id] : [kind]);

  before(async () => { db = await setup(); });

  it("pengingat hanya untuk jobdesk aktif yang masuk jendela pengingat, sekali per tenggat", async () => {
    const a = await task("A dalam 5 menit", "now() + interval '5 minutes'");
    const b = await task("B dalam 2 jam", "now() + interval '2 hours'");
    const c = await task("C selesai", "now() + interval '5 minutes'");
    await db.query("update tasks set done = true where id = $1", [c]);
    const d = await task("D arsip", "now() + interval '5 minutes'", ", archived_at", ", now()");
    const e = await task("E tanpa pengingat", "now() + interval '5 minutes'", ", remind_enabled", ", false");
    const f = await task("F jendela 30 menit", "now() + interval '25 minutes'", ", remind_before_min", ", 30");
    await run();
    const got = (await notifs("reminder")).map((n) => n.task_id).sort();
    assert.deepEqual(got, [a, f].sort());
    for (const id of [b, c, d, e]) assert.equal((await notifs("reminder", id)).length, 0);
    await run();
    await run();
    assert.equal((await notifs("reminder")).length, 2, "dijalankan berkali-kali tidak menambah notifikasi");
    const na = (await notifs("reminder", a))[0];
    assert.match(na.body, /^PIC Ani · tenggat \d{2}:\d{2} WIB$/);
    assert.equal(na.audience, "all");
    assert.equal(na.urgent, false);
  });

  it("jobdesk yang selesai sebelum pengingat pertama tidak pernah diingatkan, yang selesai sesudahnya tidak diingatkan lagi", async () => {
    const early = await task("Selesai cepat", "now() + interval '4 minutes'");
    await db.query("update tasks set done = true where id = $1", [early]);
    const later = await task("Selesai setelah diingatkan", "now() + interval '4 minutes'");
    await run();
    assert.equal((await notifs("reminder", early)).length, 0);
    assert.equal((await notifs("reminder", later)).length, 1);
    await db.query("update tasks set done = true where id = $1", [later]);
    await run();
    await run();
    assert.equal((await notifs("reminder", later)).length, 1);
    assert.equal((await notifs("overdue", later)).length, 0);
  });

  it("deadline yang digeser memulai siklus pengingat baru untuk tenggat baru itu", async () => {
    const id = await task("Digeser", "now() + interval '5 minutes'");
    await run();
    assert.equal((await notifs("reminder", id)).length, 1);
    await db.query("update tasks set due_at = now() + interval '8 minutes' where id = $1", [id]);
    await run();
    await run();
    assert.equal((await notifs("reminder", id)).length, 2);
  });

  it("tenggat terlewat: satu notifikasi mendesak, hanya untuk yang lewat kurang dari sehari dan pengingat aktif", async () => {
    const g = await task("G lewat 30 menit", "now() - interval '30 minutes'");
    const h = await task("H lewat 2 hari", "now() - interval '2 days'");
    const x = await task("X tanpa pengingat", "now() - interval '30 minutes'", ", remind_enabled", ", false");
    await run();
    await run();
    const n = await notifs("overdue", g);
    assert.equal(n.length, 1);
    assert.equal(n[0].urgent, true);
    assert.equal((await notifs("overdue", h)).length, 0);
    assert.equal((await notifs("overdue", x)).length, 0);
  });

  it("kejadian 'terlambat' dicatat sekali di riwayat pada waktu deadline", async () => {
    const g = (await q<{ id: string }>("select id from tasks where title = 'G lewat 30 menit'"))[0].id;
    const ev = await q<{ actor: string; created_at: string; due: string }>(
      "select e.actor, e.created_at, t.due_at due from task_events e join tasks t on t.id = e.task_id where e.task_id = $1 and e.action = 'became_late'", [g]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].actor, "Sistem");
    assert.equal(ev[0].created_at, ev[0].due, "waktu kejadian = waktu deadline");
    const old = await task("Sangat lama", "now() - interval '10 days'");
    await run();
    assert.equal((await q("select 1 from task_events where task_id = $1 and action = 'became_late'", [old])).length, 0);
  });

  it("eskalasi ke CS Lead hanya untuk prioritas tinggi yang terlambat melewati batas menit", async () => {
    const hi = await task("High terlambat 20m", "now() - interval '20 minutes'", ", priority", ", 'high'");
    const hiSoon = await task("High terlambat 5m", "now() - interval '5 minutes'", ", priority", ", 'high'");
    const med = await task("Medium terlambat 20m", "now() - interval '20 minutes'");
    await run();
    await run();
    assert.equal((await notifs("lead_overdue", hi)).length, 1);
    assert.equal((await notifs("lead_overdue", hi))[0].audience, "lead");
    assert.equal((await notifs("lead_overdue", hiSoon)).length, 0);
    assert.equal((await notifs("lead_overdue", med)).length, 0);
    // dimatikan: tidak ada eskalasi baru
    await db.exec("update app_settings set value = 'false'::jsonb where key = 'lead_escalation'");
    const hi2 = await task("High lain", "now() - interval '40 minutes'", ", priority", ", 'high'");
    await run();
    assert.equal((await notifs("lead_overdue", hi2)).length, 0);
    await db.exec("update app_settings set value = 'true'::jsonb where key = 'lead_escalation'");
    await run();
    assert.equal((await notifs("lead_overdue", hi2)).length, 1, "menyala lagi, eskalasi menyusul sekali");
  });

  it("notifikasi untuk CS Lead tidak terlihat oleh CS; yang untuk semua dan untuk PIC terlihat", async () => {
    const cs = await asUser(db, CS, () => rows<{ audience: string }>(db, "select distinct audience from notifications"));
    const lead = await asUser(db, LEAD, () => rows<{ audience: string }>(db, "select distinct audience from notifications"));
    assert.ok(!cs.some((r) => r.audience === "lead"));
    assert.ok(cs.some((r) => r.audience === "all") && cs.some((r) => r.audience === "pic"));
    assert.ok(lead.some((r) => r.audience === "lead"));
    assert.equal((await asUser(db, OUTSIDER, () => rows(db, "select 1 from notifications"))).length, 0);
  });

  it("scheduler membuat tugas berulang dari template dan mencatat waktu terakhir berjalan", async () => {
    await db.exec("insert into task_templates (title, pic, repeat_type, due_time) values ('Dari template', 'Budi', 'daily', '23:00')");
    await run();
    await run();
    assert.equal((await q("select 1 from tasks where title = 'Dari template'")).length, 2);
    const st = await asUser(db, LEAD, async () => (await rows<{ s: { last_run: string | null; cron_job: boolean; push_configured: boolean } }>(db, "select public.scheduler_status() s"))[0].s);
    assert.ok(st.last_run);
    assert.equal(st.cron_job, false, "pg_cron tidak ada di Postgres lokal; aplikasi harus melaporkannya apa adanya");
    assert.equal(st.push_configured, false);
    assert.equal(await asUser(db, OUTSIDER, () => failsWith(db, "select public.scheduler_status()")), "42501");
  });

  it("notifikasi lebih dari 30 hari dibersihkan", async () => {
    await db.exec("insert into notifications (kind, title, dedup_key, created_at) values ('reminder', 'lama', 'lama-1', now() - interval '40 days')");
    await run();
    assert.equal((await q("select 1 from notifications where dedup_key = 'lama-1'")).length, 0);
  });

  it("tabel yang perlu realtime sudah masuk publikasi", async () => {
    const t = (await q<{ tablename: string }>("select tablename from pg_publication_tables where pubname = 'supabase_realtime'")).map((x) => x.tablename).sort();
    for (const need of ["app_settings", "notifications", "task_events", "tasks", "team_members"]) assert.ok(t.includes(need), need);
  });
});

describe("scheduler: ringkasan pagi dan akhir hari (Asia/Jakarta)", () => {
  let db: PGlite;
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => rows<T>(db, sql, p);
  const run = () => db.exec("select app_private.run_scheduler()");
  const wibMinutes = async () => Number((await q<{ m: number }>("select extract(hour from now() at time zone 'Asia/Jakarta')::int * 60 + extract(minute from now() at time zone 'Asia/Jakarta')::int m"))[0].m);
  const setTime = (key: string, minusMin: number) => db.query(
    `update app_settings set value = to_jsonb(to_char((now() at time zone 'Asia/Jakarta') - make_interval(mins => $2), 'HH24:MI')) where key = $1`, [key, minusMin]);

  before(async () => {
    db = await setup();
    await db.exec(`
      insert into tasks (title, pic, due_at) values ('Terlambat 1', 'Ani', now() - interval '1 hour'), ('Besok', 'Budi', now() + interval '1 day');
      insert into tasks (title, pic, due_at, priority) values ('Selesai nanti', 'Ani', now() + interval '1 hour', 'low');
    `);
    await db.exec("update tasks set done = true where title = 'Selesai nanti'");
    await db.exec("delete from notifications");
  });

  it("ringkasan pagi muncul sekali per hari dengan angka dari data nyata", async (t) => {
    if ((await wibMinutes()) < 15) return t.skip("terlalu dekat tengah malam WIB");
    await db.exec("update app_settings set value = '\"23:59\"'::jsonb where key = 'digest_evening'");
    await setTime("digest_morning", 5);
    await run();
    await run();
    const n = await q<N>("select * from notifications where kind = 'digest_morning'");
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Ringkasan pagi: 2 jobdesk belum selesai");
    assert.match(n[0].body, /^1 terlambat: Terlambat 1 \(Ani\)$/);
    assert.equal(n[0].urgent, true);
    assert.equal((await q("select 1 from notifications where kind = 'digest_evening'")).length, 0, "akhir hari belum waktunya");
  });

  it("di luar jendela 2 jam setelah jadwal, atau saat dimatikan, tidak ada ringkasan", async (t) => {
    if ((await wibMinutes()) < 15) return t.skip("terlalu dekat tengah malam WIB");
    await db.exec("delete from notifications");
    await setTime("digest_morning", 200);
    await run();
    assert.equal((await q("select 1 from notifications where kind = 'digest_morning'")).length, 0);
    await setTime("digest_morning", 5);
    await db.exec("update app_settings set value = 'false'::jsonb where key = 'digests_enabled'");
    await run();
    assert.equal((await q("select 1 from notifications where kind = 'digest_morning'")).length, 0);
    await db.exec("update app_settings set value = 'true'::jsonb where key = 'digests_enabled'");
  });

  it("ringkasan akhir hari menghitung selesai hari ini dan yang belum selesai", async (t) => {
    if ((await wibMinutes()) < 15) return t.skip("terlalu dekat tengah malam WIB");
    await db.exec("delete from notifications");
    await db.exec("update app_settings set value = '\"23:59\"'::jsonb where key = 'digest_morning'");
    await setTime("digest_evening", 5);
    await run();
    await run();
    const n = await q<N>("select * from notifications where kind = 'digest_evening'");
    assert.equal(n.length, 1);
    assert.equal(n[0].title, "Ringkasan akhir hari: 1 selesai, 2 belum selesai");
    assert.match(n[0].body, /^1 jobdesk terlambat dan perlu tindak lanjut\.$/);
  });
});

describe("scheduler: antrean Web Push dan konfirmasi", () => {
  let db: PGlite;
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => rows<T>(db, sql, p);
  const run = () => db.exec("select app_private.run_scheduler()");
  const sub = (ep: string, member: string | null, kinds: string[] | null) => asUser(db, LEAD, () =>
    db.query("select public.upsert_push_subscription($1, 'pk', 'au', $2, $3, 'uji')", [ep, member, kinds]));
  const confirm = (secret: string, id: number, results: unknown, as: string | null = null) =>
    asUser(db, as, () => failsWith(db, "select public.confirm_push($1, $2, $3::jsonb)", [secret, id, JSON.stringify(results)]));
  const reminder = async (title: string) => {
    await db.query("insert into tasks (title, pic, due_at) values ($1, 'Ani', now() + interval '3 minutes')", [title]);
    await run();
    return (await q<N>("select * from notifications where kind = 'reminder' and title like $1", [`%${title}`]))[0];
  };
  const state = async (id: number) => (await q<N>("select * from notifications where id = $1", [id]))[0];

  before(async () => { db = await setup(); });

  it("tanpa perangkat berlangganan: status 'no_subscribers', bukan 'terkirim'", async () => {
    const n = await reminder("Satu");
    assert.equal(n.push_state, "no_subscribers");
    assert.equal((await q("select 1 from notifications where push_state = 'pending'")).length, 0);
  });

  it("ada perangkat tapi push belum dikonfigurasi: 'not_configured'", async () => {
    await sub("https://push.example/a", "Ani", null);
    const n = await reminder("Dua");
    assert.equal(n.push_state, "not_configured");
  });

  it("dikonfigurasi: masuk antrean ke endpoint dengan secret, status 'queued' sampai ada konfirmasi", async () => {
    await db.exec("insert into app_private.settings (key, value) values ('push_url', 'https://situs.example/api/push'), ('push_secret', 'rahasia-uji')");
    const n = await reminder("Tiga");
    assert.equal(n.push_state, "queued");
    const call = (await q<{ url: string; body: { id: number; subscriptions: { endpoint: string }[]; title: string }; headers: Record<string, string> }>("select * from net.calls order by id desc limit 1"))[0];
    assert.equal(call.url, "https://situs.example/api/push");
    assert.equal(call.headers["x-push-secret"], "rahasia-uji");
    assert.equal(Number(call.body.id), Number(n.id));
    assert.deepEqual(call.body.subscriptions.map((s) => s.endpoint), ["https://push.example/a"]);
    assert.notEqual(n.push_state, "sent");
  });

  it("konfirmasi dengan secret salah ditolak, dengan secret benar mengubah status menjadi 'sent'", async () => {
    const n = (await q<N>("select * from notifications where push_state = 'queued' order by id desc limit 1"))[0];
    const ok = [{ endpoint: "https://push.example/a", ok: true, status: 201 }];
    assert.equal(await confirm("salah", n.id, ok, null), "42501");
    assert.equal(await confirm("salah", n.id, ok, LEAD), "42501");
    assert.equal((await state(n.id)).push_state, "queued");
    assert.equal(await confirm("rahasia-uji", n.id, ok, null), null);
    const after = await state(n.id);
    assert.deepEqual([after.push_state, after.push_sent, after.push_failed], ["sent", 1, 0]);
    const s = (await q<{ last_success_at: string | null }>("select last_success_at from push_subscriptions where endpoint = 'https://push.example/a'"))[0];
    assert.ok(s.last_success_at);
  });

  it("langganan yang kedaluwarsa (410) dihapus dan notifikasi ditandai gagal", async () => {
    const n = await reminder("Empat");
    assert.equal(n.push_state, "queued");
    await confirm("rahasia-uji", n.id, [{ endpoint: "https://push.example/a", ok: false, status: 410 }], null);
    assert.equal((await state(n.id)).push_state, "failed");
    assert.equal((await q("select 1 from push_subscriptions where endpoint = 'https://push.example/a'")).length, 0);
  });

  it("dua perangkat, satu gagal: 'partial'; jenis notifikasi yang dimatikan perangkat tidak dikirimi", async () => {
    await sub("https://push.example/b", "Ani", null);
    await sub("https://push.example/c", "Ani", null);
    await sub("https://push.example/d", "Ani", ["assigned"]);
    const n = await reminder("Lima");
    const call = (await q<{ body: { subscriptions: { endpoint: string }[] } }>("select body from net.calls order by id desc limit 1"))[0];
    assert.deepEqual(call.body.subscriptions.map((s) => s.endpoint).sort(), ["https://push.example/b", "https://push.example/c"]);
    await confirm("rahasia-uji", n.id, [
      { endpoint: "https://push.example/b", ok: true, status: 201 },
      { endpoint: "https://push.example/c", ok: false, status: 500 },
    ], null);
    const after = await state(n.id);
    assert.deepEqual([after.push_state, after.push_sent, after.push_failed], ["partial", 1, 1]);
    assert.equal((await q<{ failed_count: number }>("select failed_count from push_subscriptions where endpoint = 'https://push.example/c'"))[0].failed_count, 1);
  });

  it("tanpa konfirmasi lebih dari 3 menit: 'unconfirmed', tidak pernah dianggap terkirim", async () => {
    const n = await reminder("Enam");
    assert.equal(n.push_state, "queued");
    await db.exec(`update notifications set push_queued_at = now() - interval '5 minutes' where id = ${n.id}`);
    await run();
    assert.equal((await state(n.id)).push_state, "unconfirmed");
  });

  it("notifikasi untuk PIC hanya dikirim ke perangkat milik PIC itu; untuk CS Lead hanya ke perangkat lead", async () => {
    await db.exec("delete from push_subscriptions");
    await sub("https://push.example/ani", "Ani", null);
    await sub("https://push.example/budi", "Budi", null);
    await db.query("insert into tasks (title, pic, due_at, updated_by) values ('Untuk Budi', 'Budi', now() + interval '1 day', 'CS Lead')");
    await run();
    const call = (await q<{ body: { kind: string; subscriptions: { endpoint: string }[] } }>("select body from net.calls where body ->> 'kind' = 'assigned' order by id desc limit 1"))[0];
    assert.deepEqual(call.body.subscriptions.map((s) => s.endpoint), ["https://push.example/budi"]);
    await asUser(db, CS, () => db.query("select public.upsert_push_subscription('https://push.example/cs-ani', 'pk', 'au', 'Ani', null, 'uji')"));
    await db.query("insert into tasks (title, pic, due_at, priority) values ('Kritis', 'Ani', now() - interval '30 minutes', 'high')");
    await run();
    const lead = (await q<{ body: { kind: string; subscriptions: { endpoint: string }[] } }>("select body from net.calls where body ->> 'kind' = 'lead_overdue' order by id desc limit 1"))[0];
    assert.deepEqual(lead.body.subscriptions.map((x) => x.endpoint).sort(), ["https://push.example/ani", "https://push.example/budi"],
      "perangkat berperan CS tidak menerima eskalasi untuk CS Lead");
    const overdue = (await q<{ body: { subscriptions: { endpoint: string }[] } }>("select body from net.calls where body ->> 'kind' = 'overdue' order by id desc limit 1"))[0];
    assert.ok(overdue.body.subscriptions.some((x) => x.endpoint === "https://push.example/cs-ani"), "pemberitahuan umum tetap sampai ke CS");
  });

  it("pendaftaran perangkat: harus login, endpoint harus https, CS punya perangkat sendiri", async () => {
    assert.equal(await asUser(db, OUTSIDER, () => failsWith(db, "select public.upsert_push_subscription('https://x.example/1','a','b',null,null,'ua')")), "42501");
    assert.equal(await asUser(db, null, () => failsWith(db, "select public.upsert_push_subscription('https://x.example/1','a','b',null,null,'ua')")), "42501");
    assert.equal(await asUser(db, LEAD, () => failsWith(db, "select public.upsert_push_subscription('http://x.example/1','a','b',null,null,'ua')")), "22023");
    assert.equal(await asUser(db, CS, () => failsWith(db, "select public.upsert_push_subscription('https://x.example/cs','a','b','Ani',array['reminder'],'ua')")), null);
    const mine = await asUser(db, CS, async () => (await rows<{ r: { member_name: string; kinds: string[] } }>(db, "select public.get_my_push_subscription('https://x.example/cs') r"))[0].r);
    assert.deepEqual([mine.member_name, mine.kinds], ["Ani", ["reminder"]]);
    await asUser(db, CS, () => db.query("select public.remove_push_subscription('https://x.example/cs')"));
    assert.equal((await q("select 1 from push_subscriptions where endpoint = 'https://x.example/cs'")).length, 0);
  });
});
