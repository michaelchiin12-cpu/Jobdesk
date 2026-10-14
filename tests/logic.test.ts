import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Member, Task } from "../lib/types";
import * as tz from "../lib/tz";
import {
  alertTasks, applyFilters, dashStats, DEFAULT_FILTERS, groupTasks, MIN_SAMPLES, sortTasks, teamStats, urgency,
} from "../lib/tasks";
import { buildReport, dueCohort, fetchWindow, outcomeOf, rangeFor, shiftAnchor, trendDays } from "../lib/metrics";
import { csvCell, taskCsvRows, toCsv, TASK_CSV_HEADERS } from "../lib/csv";
import { validateLateReason, validateTaskForm, validateTemplateForm, type TaskForm } from "../lib/validation";

// Selasa 13 Oktober 2026, 11:00 WIB
const w = (s: string): number => Date.parse(s.replace(" ", "T") + ":00+07:00");
const NOW = w("2026-10-13 11:00");
let seq = 0;
const task = (o: Partial<Task> & { due: string }): Task => {
  const { due, ...rest } = o;
  seq++;
  return {
    id: `t${seq}`, title: `Tugas ${seq}`, pic: "Sari", due_at: new Date(w(due)).toISOString(), note: null,
    priority: "medium", status: "todo", done: false, done_at: null, started_at: null,
    original_due_at: null, original_pic: null, late_reason: null, late_note: null,
    remind_enabled: true, remind_before_min: 10, template_id: null, occurrence_date: null,
    created_at: new Date(w("2026-10-01 08:00")).toISOString(), updated_at: new Date(NOW).toISOString(),
    updated_by: null, archived_at: null, ...rest,
  };
};
const iso = (s: string) => new Date(w(s)).toISOString();
const member = (name: string, absent_on: string | null = null): Member =>
  ({ id: name, name, absent_on, archived_at: null, created_at: iso("2026-10-01 08:00") });

describe("zona waktu Asia/Jakarta", () => {
  test("hari dan jam mengikuti WIB, bukan zona waktu proses", () => {
    // 2026-10-13 18:30 UTC = 14 Oktober 01:30 WIB
    const ms = Date.parse("2026-10-13T18:30:00Z");
    assert.equal(tz.dayKey(ms), "2026-10-14");
    assert.equal(tz.fmtTime(ms), "01:30");
    assert.equal(tz.parts(ms).dow, 3); // Rabu
  });
  test("input datetime-local dibaca sebagai WIB dan bolak-balik konsisten", () => {
    const ms = tz.parseLocalInput("2026-10-13T09:15");
    assert.equal(new Date(ms).toISOString(), "2026-10-13T02:15:00.000Z");
    assert.equal(tz.toLocalInput(ms), "2026-10-13T09:15");
  });
  test("tanggal tidak valid ditolak (31 Februari, format salah, kosong)", () => {
    for (const v of ["2026-02-31T10:00", "2026-10-13 10:00", "", "2026-13-01T10:00", "2026-10-13T25:00"]) {
      assert.ok(isNaN(tz.parseLocalInput(v)), v);
    }
  });
  test("aritmatika tanggal, minggu mulai Senin, jumlah hari bulan", () => {
    assert.equal(tz.addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(tz.addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(tz.weekStart("2026-10-13"), "2026-10-12");
    assert.equal(tz.weekStart("2026-10-18"), "2026-10-12"); // Minggu masih minggu yang sama
    assert.equal(tz.addMonths("2026-12-01", 1), "2027-01-01");
    assert.equal(tz.addMonths("2026-01-01", -1), "2025-12-01");
    assert.equal(tz.daysInMonth("2026-02-10"), 28);
    assert.equal(tz.daysInMonth("2028-02-10"), 29);
  });
  test("label hari dan teks relatif", () => {
    assert.equal(tz.dayLabel(w("2026-10-13 15:00"), NOW), "Hari ini");
    assert.equal(tz.dayLabel(w("2026-10-14 15:00"), NOW), "Besok");
    assert.equal(tz.dayLabel(w("2026-10-12 15:00"), NOW), "Kemarin");
    assert.equal(tz.relText(-12 * 60000), "terlambat 12 mnt");
    assert.equal(tz.relText(185 * 60000), "3 j 5 mnt lagi");
    assert.equal(tz.relText(-3 * 86400000), "terlambat 3 hari");
    assert.equal(tz.mmss(125_000), "02:05");
  });
});

describe("statistik dashboard", () => {
  const tasks = [
    task({ due: "2026-10-13 09:00" }), // terlambat, hari ini
    task({ due: "2026-10-13 11:30" }), // segera (30 mnt), hari ini
    task({ due: "2026-10-13 17:00" }), // nanti hari ini
    task({ due: "2026-10-14 09:00" }), // mendatang
    task({ due: "2026-10-12 09:00" }), // terlambat kemarin
    task({ due: "2026-10-13 10:00", done: true, status: "done", done_at: iso("2026-10-13 10:30") }), // selesai hari ini, deadline hari ini
    task({ due: "2026-10-10 10:00", done: true, status: "done", done_at: iso("2026-10-13 08:00") }), // selesai hari ini, deadline lalu
    task({ due: "2026-10-13 09:30", archived_at: iso("2026-10-13 09:40") }), // diarsipkan: diabaikan
  ];
  const s = dashStats(tasks, NOW);
  test("setiap angka dihitung dari data, tugas tidak dihitung dua kali, arsip diabaikan", () => {
    // deadline hari ini: 09:00, 11:30, 17:00, dan satu yang sudah selesai = 4 (yang diarsipkan tidak dihitung)
    assert.deepEqual(s, { todayTotal: 4, late: 2, soon: 1, doneToday: 2, open: 5 });
  });
  test("jumlah di kartu sama dengan jumlah baris di daftar yang dibuka kartu itu", () => {
    const count = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(tasks, { ...DEFAULT_FILTERS, ...f }, NOW).length;
    assert.equal(count({ tab: "today" }), s.todayTotal);
    assert.equal(count({ tab: "late" }), s.late);
    assert.equal(count({ quick: "soon" }), s.soon);
    assert.equal(count({ tab: "done", quick: "done_today" }), s.doneToday);
  });
  test("terlambat tidak mengubah status: tugas Dalam Proses bisa sekaligus terlambat", () => {
    const t = task({ due: "2026-10-13 09:00", status: "in_progress" });
    assert.equal(urgency(t, NOW), "late");
    assert.equal(t.status, "in_progress");
  });
});

describe("filter, pencarian, urutan, pengelompokan", () => {
  const a = task({ title: "Rekap KPI Talenta", pic: "Sari", due: "2026-10-13 09:00", priority: "high", status: "in_progress", note: "kirim ke lead" });
  const b = task({ title: "Monitoring komentar", pic: "Budi", due: "2026-10-13 15:00", priority: "low" });
  const c = task({ title: "Laporan TikTok", pic: "Sari", due: "2026-10-15 10:00", priority: "medium", status: "waiting" });
  const d = task({ title: "Laporan NPS", pic: "Budi", due: "2026-10-12 10:00", done: true, status: "done", done_at: iso("2026-10-12 09:00") });
  const all = [a, b, c, d];
  const f = (o: Partial<typeof DEFAULT_FILTERS>) => applyFilters(all, { ...DEFAULT_FILTERS, ...o }, NOW).map((t) => t.title);

  test("tab", () => {
    assert.deepEqual(f({ tab: "today" }), [a.title, b.title]);
    assert.deepEqual(f({ tab: "upcoming" }), [c.title]);
    assert.deepEqual(f({ tab: "late" }), [a.title]);
    assert.deepEqual(f({ tab: "done" }), [d.title]);
    assert.equal(f({}).length, 4);
  });
  test("pencarian: judul, catatan, PIC; kata ganda harus cocok semua; tidak peka huruf besar", () => {
    assert.deepEqual(f({ search: "kpi" }), [a.title]);
    assert.deepEqual(f({ search: "LEAD" }), [a.title]);
    assert.deepEqual(f({ search: "laporan budi" }), [d.title]);
    assert.deepEqual(f({ search: "tidak ada" }), []);
  });
  test("filter PIC, status, prioritas digabung", () => {
    assert.deepEqual(f({ pic: "Sari" }), [a.title, c.title]);
    assert.deepEqual(f({ status: "waiting" }), [c.title]);
    assert.deepEqual(f({ priority: "high" }), [a.title]);
    assert.deepEqual(f({ pic: "Sari", priority: "medium" }), [c.title]);
  });
  test("urutan: deadline, prioritas, tanggal dibuat", () => {
    assert.deepEqual(sortTasks([c, b, a], "deadline").map((t) => t.title), [a.title, b.title, c.title]);
    assert.deepEqual(sortTasks([b, c, a], "priority").map((t) => t.title), [a.title, c.title, b.title]);
    const newer = task({ due: "2026-10-20 10:00", created_at: iso("2026-10-12 08:00") });
    assert.equal(sortTasks([a, newer], "created")[0].id, newer.id);
  });
  test("pengelompokan: terlambat, hari ini, mendatang, selesai; grup kosong dibuang", () => {
    const g = groupTasks(all, NOW, "deadline");
    assert.deepEqual(g.map((x) => [x.key, x.tasks.length]), [["late", 1], ["today", 1], ["upcoming", 1], ["done", 1]]);
    assert.deepEqual(groupTasks([d], NOW, "deadline").map((x) => x.key), ["done"]);
  });
});

describe("monitoring tim", () => {
  const today = tz.dayKey(NOW);
  const members = [member("Sari"), member("Budi", today), member("Andi")];
  const done = (pic: string, due: string, doneAt: string) => task({ pic, due, done: true, status: "done", done_at: iso(doneAt) });
  const tasks = [
    task({ pic: "Sari", due: "2026-10-13 09:00", status: "in_progress", priority: "high" }), // terlambat + high
    task({ pic: "Sari", due: "2026-10-13 18:00" }),
    done("Sari", "2026-10-13 10:00", "2026-10-13 09:00"),
    done("Sari", "2026-10-12 10:00", "2026-10-12 11:00"), // terlambat
    done("Sari", "2026-10-11 10:00", "2026-10-11 09:00"),
    done("Budi", "2026-10-12 10:00", "2026-10-12 09:00"),
    task({ pic: "Orang Lama", due: "2026-10-14 10:00" }), // bukan anggota aktif tapi punya tugas
  ];
  const rows = teamStats(tasks, members, NOW);
  const get = (n: string) => rows.find((r) => r.name === n)!;

  test("hitungan per PIC", () => {
    assert.deepEqual([get("Sari").open, get("Sari").inProgress, get("Sari").late, get("Sari").highLate, get("Sari").doneToday], [2, 1, 1, 1, 1]);
    assert.deepEqual([get("Budi").open, get("Budi").absent], [0, true]);
    assert.equal(get("Andi").open, 0);
  });
  test("PIC dari tugas yang bukan anggota aktif tetap ditampilkan", () => {
    assert.equal(get("Orang Lama").open, 1);
  });
  test("persentase tepat waktu hanya muncul jika sampel cukup (>= MIN_SAMPLES)", () => {
    assert.equal(MIN_SAMPLES, 3);
    assert.equal(get("Sari").onTimeSample, 3);
    assert.equal(get("Sari").onTimePct, 67); // 2 dari 3
    assert.equal(get("Budi").onTimePct, null);
    assert.equal(get("Budi").onTimeSample, 1);
  });
});

describe("banner peringatan", () => {
  const near = task({ due: "2026-10-13 11:08", remind_before_min: 10 });
  const far = task({ due: "2026-10-13 11:30", remind_before_min: 10 });
  const wide = task({ due: "2026-10-13 11:30", remind_before_min: 45 });
  const late = task({ due: "2026-10-13 10:00" });
  const off = task({ due: "2026-10-13 10:00", remind_enabled: false });
  const done = task({ due: "2026-10-13 10:00", done: true, status: "done", done_at: iso("2026-10-13 10:30") });
  const arch = task({ due: "2026-10-13 10:00", archived_at: iso("2026-10-13 10:30") });
  const all = [near, far, wide, late, off, done, arch];

  test("mengikuti jendela pengingat tiap tugas; selesai, diarsipkan, dan pengingat mati tidak muncul", () => {
    assert.deepEqual(alertTasks(all, NOW, {}).map((t) => t.id), [late.id, near.id, wide.id]);
  });
  test("ditunda sementara, lalu muncul lagi setelah waktunya", () => {
    const snoozed = { [late.id]: NOW + 120_000 };
    assert.deepEqual(alertTasks(all, NOW, snoozed).map((t) => t.id), [near.id, wide.id]);
    assert.ok(alertTasks(all, NOW + 120_001, snoozed).some((t) => t.id === late.id));
  });
});

describe("laporan performa", () => {
  const range = rangeFor("week", "2026-10-13"); // 12-18 Okt
  const mk = (o: Partial<Task> & { due: string }) => task({ created_at: iso("2026-10-12 08:00"), ...o });
  const doneAt = (s: string) => ({ done: true, status: "done" as const, done_at: iso(s) });
  const tasks = [
    mk({ pic: "Sari", due: "2026-10-12 10:00", ...doneAt("2026-10-12 09:00"), started_at: iso("2026-10-12 08:30") }), // tepat waktu, 30 mnt
    mk({ pic: "Sari", due: "2026-10-12 10:00", ...doneAt("2026-10-12 11:00"), started_at: iso("2026-10-12 09:00") }), // terlambat, 120 mnt
    mk({ pic: "Sari", due: "2026-10-13 09:00" }), // belum selesai, lewat
    mk({ pic: "Sari", due: "2026-10-15 09:00" }), // belum jatuh tempo
    mk({ pic: "Budi", due: "2026-10-13 10:00", ...doneAt("2026-10-13 10:00"), started_at: iso("2026-10-13 09:00") }), // tepat waktu persis di deadline, 60 mnt
    mk({ pic: "Budi", due: "2026-10-20 10:00", ...doneAt("2026-10-13 08:00"), created_at: iso("2026-10-05 08:00") }), // selesai di periode, jatuh tempo di luar, dibuat di luar
    mk({ pic: "Budi", due: "2026-10-13 10:00", archived_at: iso("2026-10-13 10:30") }), // arsip diabaikan
    mk({ pic: "Budi", due: "2026-10-05 10:00", created_at: iso("2026-10-01 08:00") }), // di luar periode sama sekali
  ];
  const r = buildReport(tasks, range, NOW);

  test("rentang periode: Senin sampai Minggu, eksklusif di ujung", () => {
    assert.equal(range.fromKey, "2026-10-12");
    assert.equal(range.toKey, "2026-10-19");
    assert.equal(rangeFor("day", "2026-10-13").toKey, "2026-10-14");
    const m = rangeFor("month", "2026-02-17");
    assert.deepEqual([m.fromKey, m.toKey], ["2026-02-01", "2026-03-01"]);
    assert.equal(shiftAnchor("month", "2026-01-15", -1), "2025-12-01");
    assert.equal(shiftAnchor("week", "2026-10-13", 1), "2026-10-20");
  });
  test("kelompok dibuat, diselesaikan, dan jatuh tempo dibedakan", () => {
    assert.equal(r.totals.created, 5, "dibuat di periode: 5 (satu dibuat sebelum periode, satu diarsipkan, satu lama)");
    assert.equal(r.totals.completed, 4);
    assert.equal(r.totals.due, 5);
  });
  test("hasil tiap tugas jatuh tempo dan persentase tepat waktu", () => {
    assert.deepEqual([r.totals.onTime, r.totals.doneLate, r.totals.openLate, r.totals.upcoming], [2, 1, 1, 1]);
    assert.equal(r.totals.late, 2);
    assert.equal(r.totals.open, 2);
    assert.equal(r.totals.determined, 4, "tugas belum jatuh tempo tidak dihitung");
    assert.equal(r.totals.onTimePct, 50);
  });
  test("selesai tepat di deadline dihitung tepat waktu", () => {
    assert.equal(outcomeOf(tasks[4], NOW), "on_time");
  });
  test("rata-rata waktu pengerjaan memakai waktu mulai dan menunggu sampel cukup", () => {
    assert.equal(r.workSample, 3);
    assert.equal(r.avgWorkMs, ((30 + 120 + 60) / 3) * 60000);
    const few = buildReport(tasks.slice(0, 2), range, NOW);
    assert.equal(few.avgWorkMs, null);
    assert.equal(few.workSample, 2);
  });
  test("perbandingan antar-PIC", () => {
    const sari = r.perPic.find((p) => p.pic === "Sari")!;
    const budi = r.perPic.find((p) => p.pic === "Budi")!;
    assert.deepEqual([sari.due, sari.onTime, sari.late, sari.onTimePct], [4, 1, 2, 33]);
    assert.deepEqual([budi.due, budi.onTime, budi.late, budi.onTimePct], [1, 1, 0, 100]);
  });
  test("filter PIC mempersempit seluruh metrik", () => {
    const only = buildReport(tasks, range, NOW, "Budi");
    assert.equal(only.totals.due, 1);
    assert.equal(only.perPic.length, 1);
  });
  test("tren harian: selesai dan terlambat per hari", () => {
    assert.equal(r.trend.length, 7);
    const day = (k: string) => r.trend.find((p) => p.key === k)!;
    assert.deepEqual([day("2026-10-12").completed, day("2026-10-12").late], [2, 1]);
    assert.deepEqual([day("2026-10-13").completed, day("2026-10-13").late], [2, 1]);
    assert.deepEqual(trendDays(rangeFor("day", "2026-10-13")).length, 7, "harian menampilkan 7 hari");
    assert.equal(rangeFor("month", "2026-10-13") && trendDays(rangeFor("month", "2026-10-13")).length, 31);
  });
  test("data kosong ditandai, bukan angka dummy", () => {
    const empty = buildReport([], range, NOW);
    assert.equal(empty.hasData, false);
    assert.equal(empty.totals.onTimePct, null);
    assert.equal(empty.avgWorkMs, null);
  });
  test("kohort ekspor sesuai filter PIC dan urut deadline; jendela fetch mencakup tren", () => {
    assert.equal(dueCohort(tasks, range, "all").length, 5);
    assert.equal(dueCohort(tasks, range, "Budi").length, 1);
    const dayRange = rangeFor("day", "2026-10-13");
    assert.equal(fetchWindow(dayRange).from, tz.dayStart("2026-10-07"));
  });
});

describe("ekspor CSV", () => {
  test("escape koma, kutip, baris baru; BOM dan CRLF", () => {
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell("baris\nbaru"), '"baris\nbaru"');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(5), "5");
    const out = toCsv(["A", "B"], [["1", "2"]]);
    assert.ok(out.startsWith("﻿A,B\r\n1,2\r\n"));
  });
  test("sel yang diawali rumus dinetralkan", () => {
    for (const v of ["=1+1", "+cmd", "-2", "@SUM(A1)"]) assert.equal(csvCell(v), "'" + v);
    assert.equal(csvCell(-3), "-3", "angka asli tidak diubah");
  });
  test("baris tugas: jumlah kolom sama dengan header, waktu WIB, hasil terbaca", () => {
    const t = task({ title: "=HYPERLINK()", due: "2026-10-13 09:00", late_reason: "waiting_info", late_note: "tunggu, ya" });
    const rows = taskCsvRows([t], NOW);
    assert.equal(rows[0].length, TASK_CSV_HEADERS.length);
    assert.equal(rows[0][5], "Belum selesai, lewat deadline");
    assert.equal(rows[0][7], "2026-10-13 09:00");
    assert.equal(rows[0][11], "Menunggu informasi atau konfirmasi");
    const csv = toCsv(TASK_CSV_HEADERS, rows);
    assert.ok(csv.includes("'=HYPERLINK()"));
    assert.ok(csv.includes('"tunggu, ya"'));
  });
});

describe("validasi form", () => {
  const base: TaskForm = {
    title: "Rekap", note: "", pic: "Sari", due: "2026-10-13T17:00", priority: "medium", status: "todo",
    remindEnabled: true, remindBefore: "10", repeat: "none",
  };
  const run = (o: Partial<TaskForm>, isNew = true) => validateTaskForm({ ...base, ...o }, ["Sari", "Budi"], NOW, isNew);

  test("form valid tidak punya error", () => {
    const c = run({});
    assert.deepEqual(c.errors, {});
    assert.equal(c.dueMs, w("2026-10-13 17:00"));
  });
  test("judul, PIC, deadline, pengingat wajib valid dengan pesan yang jelas", () => {
    assert.match(run({ title: "   " }).errors.title, /judul/i);
    assert.match(run({ title: "x".repeat(121) }).errors.title, /120/);
    assert.match(run({ pic: "" }).errors.pic, /PIC/);
    assert.match(run({ pic: "Orang Asing" }).errors.pic, /tidak ada/);
    assert.match(run({ due: "" }).errors.due, /deadline/i);
    assert.match(run({ remindBefore: "0" }).errors.remindBefore, /1 dan 1440/);
    assert.match(run({ remindBefore: "1.5" }).errors.remindBefore, /1 dan 1440/);
    assert.deepEqual(run({ remindEnabled: false, remindBefore: "abc" }).errors, {});
    assert.match(run({ note: "x".repeat(1001) }).errors.note, /1000/);
  });
  test("deadline lewat pada jobdesk baru hanya peringatan, bukan error; saat edit tidak ada peringatan", () => {
    const c = run({ due: "2026-10-13T08:00" });
    assert.deepEqual(c.errors, {});
    assert.equal(c.warnings.length, 1);
    assert.equal(run({ due: "2026-10-13T08:00" }, false).warnings.length, 0);
  });
  test("template: jam, hari, tanggal, mulai", () => {
    const t = { title: "Rutin", note: "", pic: "Sari", priority: "medium" as const, repeatType: "weekly" as const, weekday: "3", monthDay: "", dueTime: "09:00", startsOn: "2026-10-14", remindEnabled: true, remindBefore: "10" };
    assert.deepEqual(validateTemplateForm(t, ["Sari"]), {});
    assert.match(validateTemplateForm({ ...t, weekday: "" }, ["Sari"]).weekday, /hari/);
    assert.match(validateTemplateForm({ ...t, repeatType: "monthly", monthDay: "32" }, ["Sari"]).monthDay, /1 dan 31/);
    assert.match(validateTemplateForm({ ...t, dueTime: "9:00" }, ["Sari"]).dueTime, /HH:MM/);
    assert.match(validateTemplateForm({ ...t, startsOn: "2026-02-31" }, ["Sari"]).startsOn, /valid/);
  });
  test("alasan keterlambatan", () => {
    assert.deepEqual(validateLateReason("other", "ok"), {});
    assert.match(validateLateReason("", "").reason, /Pilih/);
    assert.match(validateLateReason("ngawur", "").reason, /tidak dikenal/);
    assert.match(validateLateReason("other", "x".repeat(501)).note, /500/);
  });
});
