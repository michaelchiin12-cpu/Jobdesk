import type { Task } from "./types";
import { createdMs, doneMs, dueMs, MIN_SAMPLES } from "./tasks";
import { addDays, addMonths, dayKey, dayStart, fmtKeyShort, monthLabel, monthStart, weekStart } from "./tz";

/*
 * Definisi metrik laporan (dipakai UI dan ekspor CSV, satu sumber kebenaran):
 *
 *  Dibuat           : tugas dengan waktu dibuat di dalam periode.
 *  Diselesaikan     : tugas dengan waktu selesai di dalam periode (apa pun deadline-nya).
 *  Jatuh tempo      : tugas dengan deadline terbaru di dalam periode. Ini kelompok utama untuk
 *                     menilai ketepatan waktu, karena setiap tugas punya hasil yang jelas.
 *  Hasil tiap tugas jatuh tempo:
 *    Tepat waktu         = selesai dan waktu selesai <= deadline
 *    Selesai terlambat   = selesai dan waktu selesai > deadline
 *    Belum selesai, lewat deadline
 *    Belum selesai, belum jatuh tempo (periode masih berjalan)
 *  Ketepatan waktu  : tepat waktu / (tepat waktu + selesai terlambat + belum selesai lewat deadline).
 *                     Tugas yang belum jatuh tempo tidak dihitung karena hasilnya belum diketahui.
 *  Waktu pengerjaan : rata-rata (waktu selesai - waktu mulai) untuk tugas selesai di periode yang
 *                     memiliki waktu mulai. Ditampilkan hanya jika sampel >= MIN_SAMPLES.
 *  Tugas yang diarsipkan tidak dihitung.
 */

export type Period = "day" | "week" | "month";

export interface Range {
  period: Period;
  from: number;
  to: number; // eksklusif
  fromKey: string;
  toKey: string; // eksklusif
  label: string;
}

export const PERIOD_LABEL: Record<Period, string> = { day: "Harian", week: "Mingguan", month: "Bulanan" };

export function rangeFor(period: Period, anchorKey: string): Range {
  let fromKey: string;
  let toKey: string;
  let label: string;
  if (period === "day") {
    fromKey = anchorKey;
    toKey = addDays(anchorKey, 1);
    label = fmtKeyShort(anchorKey);
  } else if (period === "week") {
    fromKey = weekStart(anchorKey);
    toKey = addDays(fromKey, 7);
    label = `${fmtKeyShort(fromKey)} - ${fmtKeyShort(addDays(toKey, -1))}`;
  } else {
    fromKey = monthStart(anchorKey);
    toKey = addMonths(fromKey, 1);
    label = monthLabel(fromKey);
  }
  return { period, from: dayStart(fromKey), to: dayStart(toKey), fromKey, toKey, label };
}

export function shiftAnchor(period: Period, anchorKey: string, dir: -1 | 1): string {
  if (period === "day") return addDays(anchorKey, dir);
  if (period === "week") return addDays(anchorKey, 7 * dir);
  return addMonths(monthStart(anchorKey), dir);
}

/** Rentang tanggal untuk grafik tren (harian menampilkan 7 hari terakhir). */
export function trendDays(range: Range): string[] {
  const start = range.period === "day" ? addDays(range.fromKey, -6) : range.fromKey;
  const days: string[] = [];
  for (let k = start; k < range.toKey; k = addDays(k, 1)) days.push(k);
  return days;
}

/** Rentang waktu data yang perlu diambil dari database untuk laporan ini. */
export function fetchWindow(range: Range): { from: number; to: number } {
  const days = trendDays(range);
  return { from: dayStart(days[0]), to: range.to };
}

export type Outcome = "on_time" | "done_late" | "open_late" | "upcoming" | "unknown";

export function outcomeOf(t: Task, now: number): Outcome {
  if (t.done) {
    const d = doneMs(t);
    if (d === null) return "unknown";
    return d <= dueMs(t) ? "on_time" : "done_late";
  }
  return dueMs(t) < now ? "open_late" : "upcoming";
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  on_time: "Tepat waktu",
  done_late: "Selesai terlambat",
  open_late: "Belum selesai, lewat deadline",
  upcoming: "Belum selesai, belum jatuh tempo",
  unknown: "Selesai, waktu selesai tidak tercatat",
};

export interface Counts {
  created: number;
  completed: number;
  due: number;
  onTime: number;
  doneLate: number;
  openLate: number;
  upcoming: number;
  /** Tugas jatuh tempo yang terlambat (selesai terlambat + belum selesai lewat deadline). */
  late: number;
  /** Tugas jatuh tempo yang belum selesai. */
  open: number;
  determined: number;
  onTimePct: number | null;
}

export interface PicRow extends Counts {
  pic: string;
}

export interface TrendPoint {
  key: string;
  completed: number;
  late: number;
}

export interface Report {
  range: Range;
  totals: Counts;
  avgWorkMs: number | null;
  workSample: number;
  perPic: PicRow[];
  trend: TrendPoint[];
  hasData: boolean;
}

const emptyCounts = (): Counts => ({
  created: 0, completed: 0, due: 0, onTime: 0, doneLate: 0, openLate: 0, upcoming: 0,
  late: 0, open: 0, determined: 0, onTimePct: null,
});

function finish(c: Counts): Counts {
  c.late = c.doneLate + c.openLate;
  c.open = c.openLate + c.upcoming;
  c.determined = c.onTime + c.doneLate + c.openLate;
  c.onTimePct = c.determined > 0 ? Math.round((c.onTime / c.determined) * 100) : null;
  return c;
}

const inRange = (ms: number | null, r: { from: number; to: number }): boolean => ms !== null && ms >= r.from && ms < r.to;

/** Tugas jatuh tempo pada periode (setelah filter PIC), urut menurut deadline. */
export function dueCohort(tasks: Task[], range: Range, pic: string): Task[] {
  return tasks
    .filter((t) => !t.archived_at && (pic === "all" || t.pic === pic) && inRange(dueMs(t), range))
    .sort((a, b) => dueMs(a) - dueMs(b));
}

export function buildReport(tasks: Task[], range: Range, now: number, pic = "all"): Report {
  const scoped = tasks.filter((t) => !t.archived_at && (pic === "all" || t.pic === pic));
  const totals = emptyCounts();
  const byPic = new Map<string, Counts>();
  const row = (name: string): Counts => {
    let c = byPic.get(name);
    if (!c) {
      c = emptyCounts();
      byPic.set(name, c);
    }
    return c;
  };

  let workSum = 0;
  let workSample = 0;
  const days = trendDays(range);
  const trend = new Map<string, TrendPoint>(days.map((k) => [k, { key: k, completed: 0, late: 0 }]));

  for (const t of scoped) {
    const due = dueMs(t);
    const done = doneMs(t);
    const bucket = row(t.pic);
    if (inRange(createdMs(t), range)) {
      totals.created++;
      bucket.created++;
    }
    if (t.done && inRange(done, range)) {
      totals.completed++;
      bucket.completed++;
      if (t.started_at) {
        const w = (done as number) - Date.parse(t.started_at);
        if (w >= 0) {
          workSum += w;
          workSample++;
        }
      }
    }
    if (t.done && done !== null) {
      const p = trend.get(dayKey(done));
      if (p) p.completed++;
    }
    const o = outcomeOf(t, now);
    if (o === "done_late" || o === "open_late") {
      const p = trend.get(dayKey(due));
      if (p) p.late++;
    }
    if (inRange(due, range)) {
      totals.due++;
      bucket.due++;
      for (const c of [totals, bucket]) {
        if (o === "on_time") c.onTime++;
        else if (o === "done_late") c.doneLate++;
        else if (o === "open_late") c.openLate++;
        else if (o === "upcoming") c.upcoming++;
      }
    }
  }

  finish(totals);
  const perPic: PicRow[] = [...byPic.entries()]
    .map(([name, c]) => ({ pic: name, ...finish(c) }))
    .filter((r) => r.created + r.completed + r.due > 0)
    .sort((a, b) => b.due - a.due || a.pic.localeCompare(b.pic));

  return {
    range,
    totals,
    avgWorkMs: workSample >= MIN_SAMPLES ? workSum / workSample : null,
    workSample,
    perPic,
    trend: days.map((k) => trend.get(k)!),
    hasData: totals.created + totals.completed + totals.due > 0,
  };
}
