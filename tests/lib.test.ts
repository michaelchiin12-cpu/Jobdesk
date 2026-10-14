// Logika murni: zona waktu, statistik, filter, monitoring tim, laporan, CSV, validasi.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { at, iso, member, mk, NOW } from "./helpers/fixtures";
import * as tz from "../lib/tz";
import { alertTasks, applyFilters, dashStats, DEFAULT_FILTERS, groupTasks, MIN_SAMPLES, sortTasks, teamStats, urgency, type Filters } from "../lib/tasks";
import { buildReport, dueCohort, outcomeOf, rangeFor, shiftAnchor, trendDays } from "../lib/metrics";
import { csvCell, taskCsvRows, TASK_CSV_HEADERS, toCsv } from "../lib/csv";
import { validateLateReason, validateTaskForm, validateTemplateForm, type TaskForm, type TemplateForm } from "../lib/validation";

describe("zona waktu Asia/Jakarta", () => {
  it("tanggal ditentukan menurut WIB, bukan zona browser atau UTC", () => {
    assert.equal(tz.dayKey(Date.parse("2026-10-13T17:30:00Z")), "2026-10-14");
    assert.equal(tz.dayKey(Date.parse("2026-10-13T16:59:59Z")), "2026-10-13");
    assert.equal(tz.fmtTime(Date.parse("2026-10-14T03:05:00Z")), "10:05");
    assert.equal(tz.fmtCsv(Date.parse("2026-12-31T20:00:00Z")), "2027-01-01 03:00");
    assert.equal(tz.fmtCsv(null), "");
  });
  it("input datetime-local dibaca sebagai WIB dan tanggal yang tidak ada ditolak", () => {
    assert.equal(tz.parseLocalInput("2026-10-14T10:00"), Date.parse("2026-10-14T03:00:00Z"));
    assert.ok(Number.isNaN(tz.parseLocalInput("2026-02-31T10:00")));
    assert.ok(Number.isNaN(tz.parseLocalInput("2026-10-14T24:00")));
    assert.ok(Number.isNaN(tz.parseLocalInput("2026-10-14 10:00")));
    assert.ok(Number.isNaN(tz.parseLocalInput("")));
    assert.equal(tz.toLocalInput(tz.parseLocalInput("2026-10-14T10:00")), "2026-10-14T10:00");
  });
  it("awal minggu (Senin), bulan, dan hari dalam bulan", () => {
    assert.equal(tz.weekStart("2026-10-14"), "2026-10-12");
    assert.equal(tz.weekStart("2026-10-18"), "2026-10-12", "Minggu masuk minggu yang berakhir di hari itu");
    assert.equal(tz.weekStart("2026-10-12"), "2026-10-12");
    assert.equal(tz.weekStart("2026-10-19"), "2026-10-19");
    assert.equal(tz.addMonths("2026-12-01", 1), "2027-01-01");
    assert.equal(tz.addMonths("2026-01-01", -1), "2025-12-01");
    assert.equal(tz.daysInMonth("2028-02-10"), 29);
    assert.equal(tz.daysInMonth("2027-02-10"), 28);
    assert.equal(tz.addDays("2026-10-31", 1), "2026-11-01");
  });
  it("teks waktu relatif", () => {
    assert.equal(tz.relText(-30 * 60000), "terlambat 30 mnt");
    assert.equal(tz.relText(-(2 * 3600 + 5 * 60) * 1000), "terlambat 2 j 5 mnt");
    assert.equal(tz.relText(-3 * 86400000), "terlambat 3 hari");
    assert.equal(tz.relText(5 * 60000), "5 mnt lagi");
    assert.equal(tz.relText((3 * 3600 + 10 * 60) * 1000), "3 j 10 mnt lagi");
    assert.equal(tz.mmss(125_000), "02:05");
    assert.equal(tz.fmtDuration(90 * 60000), "1 j 30 mnt");
    assert.equal(tz.dayLabel(at("09:00", 1), NOW), "Besok");
    assert.equal(tz.dayLabel(at("09:00", -1), NOW), "Kemarin");
    assert.equal(tz.dayLabel(at("09:00", 0), NOW), "Hari ini");
  });
});

describe("statistik dashboard", () => {
  const t1 = mk({ title: "Rekap KPI", due: at("09:00") });
  const t2 = mk({ title: "Balas komentar", due: at("10:30"), pic: "Budi", priority: "high" });
  const t3 = mk({ title: "Laporan TikTok", due: at("15:00"), status: "in_progress" });
  const t4 = mk({ title: "Cek NPS", due: at("09:00"), done_ms: at("08:00") });
  const t5 = mk({ title: "Kemarin selesai", due: at("09:00", -1), done_ms: at("12:00", -1) });
  const t6 = mk({ title: "Diarsipkan", due: at("11:00"), archived_at: iso(NOW) });
  const t7 = mk({ title: "Besok", due: at("09:00", 1), priority: "low" });
  const t8 = mk({ title: "Kemarin telat", due: at("17:00", -1), pic: "Budi", status: "in_progress" });
  const all = [t1, t2, t3, t4, t5, t6, t7, t8];

  it("angka kartu berasal dari data dan tidak menghitung tugas dua kali atau yang diarsipkan", () => {
    assert.deepEqual(dashStats(all, NOW), { todayTotal: 4, late: 2, soon: 1, doneToday: 1, open: 5 });
  });
  it("status pengerjaan terpisah dari kondisi deadline: Dalam Proses bisa sekaligus terlambat", () => {
    assert.equal(t8.status, "in_progress");
    assert.equal(urgency(t8, NOW), "late");
    assert.equal(urgency(t2, NOW), "soon");
    assert.equal(urgency(t3, NOW), "later");
    assert.equal(urgency(t4, NOW), "done");
  });
  it("batas 'segera': tepat 1 jam masih segera, lewat 1 jam tidak", () => {
    assert.equal(urgency(mk({ due: NOW + 3600_000 }), NOW), "soon");
    assert.equal(urgency(mk({ due: NOW + 3600_000 + 1 }), NOW), "later");
    assert.equal(urgency(mk({ due: NOW }), NOW), "soon", "tepat di detik deadline belum terlambat");
    assert.equal(urgency(mk({ due: NOW - 1 }), NOW), "late");
  });
  it("tab dan filter memberi hasil yang sama dengan angka kartu", () => {
    const f = (o: Partial<Filters>) => applyFilters(all, { ...DEFAULT_FILTERS, ...o }, NOW).map((t) => t.title).sort();
    assert.equal(f({ tab: "late" }).length, 2);
    assert.deepEqual(f({ tab: "late" }), ["Kemarin telat", "Rekap KPI"]);
    assert.deepEqual(f({ tab: "today" }), ["Balas komentar", "Cek NPS", "Laporan TikTok", "Rekap KPI"]);
    assert.deepEqual(f({ tab: "upcoming" }), ["Besok"]);
    assert.deepEqual(f({ tab: "done" }), ["Cek NPS", "Kemarin selesai"]);
    assert.equal(f({ tab: "all" }).length, 7, "arsip tidak ikut");
    assert.deepEqual(f({ quick: "soon" }), ["Balas komentar"]);
    assert.deepEqual(f({ quick: "done_today" }), ["Cek NPS"]);
    assert.equal(f({ quick: "soon" }).length, dashStats(all, NOW).soon);
    assert.equal(f({ quick: "done_today" }).length, dashStats(all, NOW).doneToday);
  });
  it("pencarian, PIC, status, prioritas, dan kombinasinya", () => {
    const f = (o: Partial<Filters>) => applyFilters(all, { ...DEFAULT_FILTERS, ...o }, NOW).map((t) => t.title).sort();
    assert.deepEqual(f({ search: "kpi" }), ["Rekap KPI"]);
    assert.deepEqual(f({ search: "  LAPORAN   tiktok " }), ["Laporan TikTok"]);
    assert.deepEqual(f({ search: "budi" }), ["Balas komentar", "Kemarin telat"], "mencari juga nama PIC");
    assert.deepEqual(f({ search: "tidak ada" }), []);
    assert.deepEqual(f({ pic: "Budi" }), ["Balas komentar", "Kemarin telat"]);
    assert.deepEqual(f({ status: "in_progress" }), ["Kemarin telat", "Laporan TikTok"]);
    assert.deepEqual(f({ priority: "high" }), ["Balas komentar"]);
    assert.deepEqual(f({ pic: "Budi", status: "in_progress" }), ["Kemarin telat"]);
    assert.deepEqual(f({ pic: "Budi", tab: "today", priority: "high" }), ["Balas komentar"]);
    assert.deepEqual(f({ pic: "Ani", priority: "high" }), []);
  });
  it("urutan: deadline, prioritas (lalu deadline), tanggal dibuat", () => {
    const names = (s: "deadline" | "priority" | "created", list = all.filter((t) => !t.archived_at && !t.done)) => sortTasks(list, s).map((t) => t.title);
    assert.deepEqual(names("deadline"), ["Kemarin telat", "Rekap KPI", "Balas komentar", "Laporan TikTok", "Besok"]);
    assert.deepEqual(names("priority"), ["Balas komentar", "Kemarin telat", "Rekap KPI", "Laporan TikTok", "Besok"]);
    const a = mk({ due: at("12:00"), created_ms: at("07:00") });
    const b = mk({ due: at("12:00"), created_ms: at("09:00") });
    assert.deepEqual(sortTasks([a, b], "created").map((t) => t.id), [b.id, a.id]);
    const before = [t3, t1];
    sortTasks(before, "deadline");
    assert.deepEqual(before, [t3, t1], "tidak mengubah array asli");
  });
  it("pengelompokan: terlambat, hari ini, mendatang, selesai; grup kosong dibuang", () => {
    const g = groupTasks(applyFilters(all, DEFAULT_FILTERS, NOW), NOW, "deadline");
    assert.deepEqual(g.map((x) => [x.key, x.tasks.length]), [["late", 2], ["today", 2], ["upcoming", 1], ["done", 2]]);
    assert.deepEqual(g.find((x) => x.key === "done")!.tasks.map((t) => t.title), ["Cek NPS", "Kemarin selesai"], "selesai terbaru dulu");
    assert.deepEqual(groupTasks([t7], NOW, "deadline").map((x) => x.key), ["upcoming"]);
    assert.deepEqual(groupTasks([], NOW, "deadline"), []);
  });
});

describe("monitoring tim", () => {
  const ani = member("Ani");
  const budi = member("Budi", { absent_on: "2026-10-14" });
  const lama = member("Lama", { archived_at: iso(NOW) });
  const tasks = [
    mk({ due: at("09:00"), pic: "Ani", priority: "high" }),
    mk({ due: at("15:00"), pic: "Ani", status: "in_progress" }),
    mk({ due: at("09:00"), pic: "Ani", done_ms: at("08:30") }),
    mk({ due: at("12:00", -1), pic: "Ani", done_ms: at("11:00", -1) }),
    mk({ due: at("12:00", -2), pic: "Ani", done_ms: at("13:00", -2) }),
    mk({ due: at("17:00"), pic: "Budi" }),
    mk({ due: at("17:00"), pic: "Yatim" }),
    mk({ due: at("17:00"), pic: "Lama", archived_at: iso(NOW) }),
  ];
  const rows = teamStats(tasks, [ani, budi, lama], NOW);
  const by = (n: string) => rows.find((r) => r.name === n)!;

  it("menghitung beban kerja per PIC dari data", () => {
    assert.deepEqual([by("Ani").open, by("Ani").inProgress, by("Ani").late, by("Ani").highLate, by("Ani").doneToday], [2, 1, 1, 1, 1]);
    assert.deepEqual([by("Budi").open, by("Budi").late], [1, 0]);
  });
  it("menandai anggota yang tidak masuk hari ini, mengecualikan anggota nonaktif, memuat PIC yatim", () => {
    assert.equal(by("Budi").absent, true);
    assert.equal(by("Ani").absent, false);
    assert.ok(!rows.some((r) => r.name === "Lama"));
    assert.equal(by("Yatim").open, 1, "jobdesk PIC yang tidak ada di tim tetap terlihat");
  });
  it("persentase tepat waktu baru ditampilkan bila sampel cukup", () => {
    assert.equal(by("Ani").onTimeSample, 3);
    assert.equal(by("Ani").onTime, 2);
    assert.equal(by("Ani").onTimePct, 67);
    assert.equal(by("Budi").onTimePct, null, "sampel kurang dari batas minimum");
    assert.ok(MIN_SAMPLES >= 3);
  });
  it("tidak ada anggota yang tampil tanpa tugas dan tanpa baris dihilangkan", () => {
    assert.deepEqual(teamStats([], [ani, budi], NOW).map((r) => [r.name, r.open, r.onTimePct]), [["Ani", 0, null], ["Budi", 0, null]]);
  });
});

describe("peringatan banner", () => {
  const near = mk({ due: NOW + 8 * 60000 });
  const far = mk({ due: NOW + 40 * 60000 });
  const late = mk({ due: NOW - 5 * 60000 });
  it("muncul di dalam jendela pengingat tiap jobdesk dan terus muncul setelah lewat deadline", () => {
    assert.deepEqual(alertTasks([far, late, near], NOW, {}).map((t) => t.id), [late.id, near.id]);
    assert.deepEqual(alertTasks([mk({ due: NOW + 40 * 60000, remind_before_min: 60 })], NOW, {}).length, 1);
  });
  it("tidak muncul untuk yang selesai, diarsipkan, pengingat mati, atau sedang disembunyikan", () => {
    const done = mk({ due: NOW - 60000, done_ms: NOW - 120000 });
    const arch = mk({ due: NOW - 60000, archived_at: iso(NOW) });
    const off = mk({ due: NOW - 60000, remind_enabled: false });
    assert.equal(alertTasks([done, arch, off], NOW, {}).length, 0);
    assert.equal(alertTasks([near], NOW, { [near.id]: NOW + 1000 }).length, 0);
    assert.equal(alertTasks([near], NOW, { [near.id]: NOW - 1 }).length, 1, "sembunyi sementara sudah habis");
  });
});

describe("laporan performa", () => {
  const day = rangeFor("day", "2026-10-14");
  const week = rangeFor("week", "2026-10-14");
  const month = rangeFor("month", "2026-10-14");

  it("rentang periode benar dan eksklusif di ujung akhir", () => {
    assert.deepEqual([day.fromKey, day.toKey], ["2026-10-14", "2026-10-15"]);
    assert.deepEqual([week.fromKey, week.toKey], ["2026-10-12", "2026-10-19"]);
    assert.deepEqual([month.fromKey, month.toKey], ["2026-10-01", "2026-11-01"]);
    assert.equal(day.to - day.from, 86400000);
    assert.equal(shiftAnchor("week", "2026-10-14", -1), "2026-10-07");
    assert.equal(shiftAnchor("month", "2026-10-31", 1), "2026-11-01");
    assert.equal(trendDays(day).length, 7);
    assert.equal(trendDays(week).length, 7);
    assert.equal(trendDays(month).length, 31);
  });

  const tasks = [
    mk({ due: at("09:00"), done_ms: at("08:30"), pic: "Ani", started_at: iso(at("08:00")), created_ms: at("07:00") }), // tepat waktu
    mk({ due: at("09:00"), done_ms: at("09:30"), pic: "Ani", started_at: iso(at("08:30")), created_ms: at("07:00") }), // selesai terlambat
    mk({ due: at("09:30"), pic: "Ani", created_ms: at("07:00") }), // belum selesai, lewat deadline
    mk({ due: at("18:00"), pic: "Budi", created_ms: at("07:00") }), // belum jatuh tempo
    mk({ due: at("09:00", -1), done_ms: at("10:00", 0), pic: "Budi", started_at: iso(at("09:00")), created_ms: at("09:00", -3) }), // jatuh tempo kemarin, selesai hari ini
    mk({ due: at("09:00"), archived_at: iso(NOW), pic: "Ani" }), // diarsipkan
    mk({ due: at("00:00", 1), pic: "Budi", created_ms: at("12:00", -5) }), // tepat awal besok: di luar hari ini
  ];

  it("hasil tiap tugas jatuh tempo", () => {
    assert.deepEqual(tasks.slice(0, 4).map((t) => outcomeOf(t, NOW)), ["on_time", "done_late", "open_late", "upcoming"]);
    assert.equal(outcomeOf(mk({ due: at("09:00"), done_ms: at("09:00") }), NOW), "on_time", "selesai tepat di deadline dianggap tepat waktu");
  });

  it("laporan harian: dibuat, selesai, jatuh tempo, ketepatan waktu", () => {
    const r = buildReport(tasks, day, NOW);
    assert.equal(r.totals.created, 4);
    assert.equal(r.totals.completed, 3, "selesai di periode, apa pun deadline-nya");
    assert.equal(r.totals.due, 4, "deadline hari ini: 4 (arsip dan besok 00:00 tidak masuk)");
    assert.deepEqual([r.totals.onTime, r.totals.doneLate, r.totals.openLate, r.totals.upcoming], [1, 1, 1, 1]);
    assert.equal(r.totals.late, 2);
    assert.equal(r.totals.open, 2);
    assert.equal(r.totals.determined, 3, "yang belum jatuh tempo belum dihitung");
    assert.equal(r.totals.onTimePct, 33);
    assert.equal(r.hasData, true);
  });

  it("tugas yang hanya dibuat di periode dibedakan dari yang jatuh tempo di periode", () => {
    const r = buildReport(tasks, rangeFor("day", "2026-10-13"), NOW);
    assert.equal(r.totals.due, 1);
    assert.equal(r.totals.created, 0);
    assert.equal(r.totals.completed, 0);
    assert.equal(r.totals.doneLate, 1, "jatuh tempo kemarin, selesai terlambat hari ini");
  });

  it("per PIC, filter PIC, dan urutan", () => {
    const r = buildReport(tasks, day, NOW);
    assert.deepEqual(r.perPic.map((p) => [p.pic, p.due]), [["Ani", 3], ["Budi", 1]]);
    const onlyBudi = buildReport(tasks, day, NOW, "Budi");
    assert.deepEqual(onlyBudi.perPic.map((p) => p.pic), ["Budi"]);
    assert.equal(onlyBudi.totals.due, 1);
    assert.deepEqual(dueCohort(tasks, day, "Ani").map((t) => t.pic), ["Ani", "Ani", "Ani"]);
  });

  it("rata-rata waktu pengerjaan hanya muncul bila sampel cukup", () => {
    const few = buildReport(tasks, day, NOW);
    assert.equal(few.workSample, 3);
    assert.equal(few.avgWorkMs, ((30 + 60 + 60) / 3) * 60000);
    const one = buildReport(tasks.slice(0, 1), day, NOW);
    assert.equal(one.avgWorkMs, null);
  });

  it("tren: selesai per hari dan terlambat per hari jatuh tempo", () => {
    const r = buildReport(tasks, week, NOW);
    const d = (k: string) => r.trend.find((p) => p.key === k)!;
    assert.equal(d("2026-10-14").completed, 3);
    assert.equal(d("2026-10-14").late, 2);
    assert.equal(d("2026-10-13").late, 1, "yang jatuh tempo kemarin dan selesai terlambat");
    assert.equal(r.trend.length, 7);
  });

  it("periode kosong menandai data belum cukup, tanpa angka palsu", () => {
    const r = buildReport([], day, NOW);
    assert.equal(r.hasData, false);
    assert.equal(r.totals.onTimePct, null);
    assert.equal(r.avgWorkMs, null);
    assert.deepEqual(r.perPic, []);
  });

  it("mingguan dan bulanan memakai batas yang benar", () => {
    const sunday = mk({ due: Date.parse("2026-10-18T23:59:00+07:00"), pic: "Ani" });
    const monday = mk({ due: Date.parse("2026-10-19T00:00:00+07:00"), pic: "Ani" });
    assert.equal(buildReport([sunday, monday], week, NOW).totals.due, 1);
    assert.equal(buildReport([sunday, monday], month, NOW).totals.due, 2);
  });
});

describe("ekspor CSV", () => {
  it("meloloskan koma, tanda kutip, dan baris baru", () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('dia bilang "ya"'), '"dia bilang ""ya"""');
    assert.equal(csvCell("baris1\nbaris2"), '"baris1\nbaris2"');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(5), "5");
  });
  it("menetralkan sel yang diawali rumus agar tidak dieksekusi spreadsheet", () => {
    assert.equal(csvCell("=HYPERLINK(\"http://x\")"), '"\'=HYPERLINK(""http://x"")"');
    assert.equal(csvCell("+1"), "'+1");
    assert.equal(csvCell("-2"), "'-2");
    assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
    assert.equal(csvCell(-3), "-3", "angka sungguhan tidak diubah");
  });
  it("baris sesuai jumlah kolom dan berisi data sesuai zona WIB", () => {
    const t = mk({ title: "Rekap, KPI", due: at("09:00"), done_ms: at("08:30"), pic: "Ani", priority: "high", late_reason: "waiting_info", late_note: "tunggu" });
    const rowsOut = taskCsvRows([t], NOW);
    assert.equal(rowsOut[0].length, TASK_CSV_HEADERS.length);
    assert.equal(rowsOut[0][0], "Rekap, KPI");
    assert.equal(rowsOut[0][3], "High");
    assert.equal(rowsOut[0][5], "Tepat waktu");
    assert.equal(rowsOut[0][7], "2026-10-14 09:00");
    const csv = toCsv(TASK_CSV_HEADERS, rowsOut);
    assert.ok(csv.startsWith("﻿Judul,PIC"));
    assert.ok(csv.includes('"Rekap, KPI"'));
    assert.ok(csv.endsWith("\r\n"));
  });
});

describe("validasi form", () => {
  const form = (o: Partial<TaskForm> = {}): TaskForm => ({
    title: "Rekap KPI", note: "", pic: "Ani", due: "2026-10-14T15:00", priority: "medium", status: "todo",
    remindEnabled: true, remindBefore: "10", repeat: "none", ...o,
  });
  const names = ["Ani", "Budi"];
  it("form yang benar lolos tanpa error", () => {
    const r = validateTaskForm(form(), names, NOW, true);
    assert.deepEqual(r.errors, {});
    assert.equal(r.dueMs, at("15:00"));
    assert.equal(r.remindBefore, 10);
  });
  it("menolak judul kosong, kepanjangan, PIC tidak valid, deadline tidak valid", () => {
    assert.ok(validateTaskForm(form({ title: "   " }), names, NOW, true).errors.title);
    assert.ok(validateTaskForm(form({ title: "x".repeat(121) }), names, NOW, true).errors.title);
    assert.equal(validateTaskForm(form({ title: "x".repeat(120) }), names, NOW, true).errors.title, undefined);
    assert.ok(validateTaskForm(form({ pic: "" }), names, NOW, true).errors.pic);
    assert.ok(validateTaskForm(form({ pic: "Orang Asing" }), names, NOW, true).errors.pic);
    assert.ok(validateTaskForm(form({ due: "" }), names, NOW, true).errors.due);
    assert.ok(validateTaskForm(form({ due: "2026-02-31T10:00" }), names, NOW, true).errors.due);
    assert.ok(validateTaskForm(form({ note: "n".repeat(1001) }), names, NOW, true).errors.note);
  });
  it("deadline yang sudah lewat hanya peringatan untuk jobdesk baru, bukan untuk edit", () => {
    const past = form({ due: "2026-10-14T08:00" });
    assert.equal(validateTaskForm(past, names, NOW, true).warnings.length, 1);
    assert.deepEqual(validateTaskForm(past, names, NOW, true).errors, {});
    assert.equal(validateTaskForm(past, names, NOW, false).warnings.length, 0);
  });
  it("pengingat divalidasi hanya saat aktif, harus bilangan bulat 1 sampai 1440", () => {
    for (const bad of ["0", "-5", "1441", "3.5", "abc", ""]) assert.ok(validateTaskForm(form({ remindBefore: bad }), names, NOW, true).errors.remindBefore, bad);
    for (const ok of ["1", "10", "1440"]) assert.equal(validateTaskForm(form({ remindBefore: ok }), names, NOW, true).errors.remindBefore, undefined, ok);
    assert.deepEqual(validateTaskForm(form({ remindEnabled: false, remindBefore: "abc" }), names, NOW, true).errors, {});
  });
  it("template: jam, tanggal mulai, hari, dan tanggal bulanan", () => {
    const t = (o: Partial<TemplateForm> = {}): TemplateForm => ({
      title: "Laporan NPS", note: "", pic: "Ani", priority: "medium", repeatType: "weekly", weekday: "1", monthDay: "1",
      dueTime: "17:00", startsOn: "2026-10-14", remindEnabled: true, remindBefore: "10", ...o,
    });
    assert.deepEqual(validateTemplateForm(t(), names), {});
    assert.ok(validateTemplateForm(t({ dueTime: "25:00" }), names).dueTime);
    assert.ok(validateTemplateForm(t({ dueTime: "9:00" }), names).dueTime);
    assert.ok(validateTemplateForm(t({ startsOn: "2026-02-31" }), names).startsOn);
    assert.ok(validateTemplateForm(t({ weekday: "8" }), names).weekday);
    assert.equal(validateTemplateForm(t({ repeatType: "daily", weekday: "" }), names).weekday, undefined, "hari hanya wajib untuk mingguan");
    assert.ok(validateTemplateForm(t({ repeatType: "monthly", monthDay: "32" }), names).monthDay);
    assert.equal(validateTemplateForm(t({ repeatType: "monthly", monthDay: "31" }), names).monthDay, undefined);
    assert.ok(validateTemplateForm(t({ title: "" }), names).title);
  });
  it("alasan keterlambatan harus salah satu pilihan yang dikenal", () => {
    assert.deepEqual(validateLateReason("high_workload", ""), {});
    assert.ok(validateLateReason("", "").reason);
    assert.ok(validateLateReason("ngarang", "").reason);
    assert.ok(validateLateReason("other", "x".repeat(501)).note);
  });
});
