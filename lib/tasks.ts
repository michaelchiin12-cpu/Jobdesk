import type { Member, Priority, Status, Task } from "./types";
import { dayKey } from "./tz";

/** "Segera jatuh tempo" untuk statistik dan lencana: deadline dalam 1 jam ke depan. */
export const SOON_WINDOW_MS = 60 * 60 * 1000;
/** Jumlah data minimum sebelum persentase atau rata-rata ditampilkan. */
export const MIN_SAMPLES = 3;
export const ONTIME_WINDOW_MS = 7 * 24 * 3600 * 1000;

export const dueMs = (t: Task): number => Date.parse(t.due_at);
export const doneMs = (t: Task): number | null => (t.done_at ? Date.parse(t.done_at) : null);
export const createdMs = (t: Task): number => Date.parse(t.created_at);
export const isOpen = (t: Task): boolean => !t.done && !t.archived_at;

export type Urgency = "done" | "late" | "soon" | "later";

/** Kondisi deadline, terpisah dari status pengerjaan: tugas Dalam Proses bisa sekaligus terlambat. */
export function urgency(t: Task, now: number): Urgency {
  if (t.done) return "done";
  const diff = dueMs(t) - now;
  if (diff < 0) return "late";
  return diff <= SOON_WINDOW_MS ? "soon" : "later";
}

export interface DashStats {
  /** Tugas yang deadline-nya hari ini (semua status). */
  todayTotal: number;
  /** Belum selesai dan deadline sudah lewat. */
  late: number;
  /** Belum selesai, deadline dalam 1 jam ke depan. */
  soon: number;
  /** Selesai hari ini (menurut waktu selesai aktual). */
  doneToday: number;
  /** Seluruh tugas yang belum selesai. */
  open: number;
}

export function dashStats(tasks: Task[], now: number): DashStats {
  const today = dayKey(now);
  const s: DashStats = { todayTotal: 0, late: 0, soon: 0, doneToday: 0, open: 0 };
  for (const t of tasks) {
    if (t.archived_at) continue;
    if (dayKey(dueMs(t)) === today) s.todayTotal++;
    if (t.done) {
      const d = doneMs(t);
      if (d !== null && dayKey(d) === today) s.doneToday++;
      continue;
    }
    s.open++;
    const diff = dueMs(t) - now;
    if (diff < 0) s.late++;
    else if (diff <= SOON_WINDOW_MS) s.soon++;
  }
  return s;
}

export type Tab = "all" | "today" | "upcoming" | "late" | "done";
export type SortKey = "deadline" | "priority" | "created";
export type Quick = null | "soon" | "done_today";

export interface Filters {
  tab: Tab;
  search: string;
  pic: string;
  status: Status | "all";
  priority: Priority | "all";
  sort: SortKey;
  quick: Quick;
}

export const DEFAULT_FILTERS: Filters = {
  tab: "all",
  search: "",
  pic: "all",
  status: "all",
  priority: "all",
  sort: "deadline",
  quick: null,
};

export const TAB_LABEL: Record<Tab, string> = {
  all: "Semua",
  today: "Hari ini",
  upcoming: "Mendatang",
  late: "Terlambat",
  done: "Selesai",
};

export function matchesTab(t: Task, tab: Tab, now: number): boolean {
  switch (tab) {
    case "all":
      return true;
    case "today":
      return dayKey(dueMs(t)) === dayKey(now);
    case "upcoming":
      return !t.done && dayKey(dueMs(t)) > dayKey(now);
    case "late":
      return !t.done && dueMs(t) < now;
    case "done":
      return t.done;
  }
}

export function matchesSearch(t: Task, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${t.title} ${t.note ?? ""} ${t.pic}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function applyFilters(tasks: Task[], f: Filters, now: number): Task[] {
  const today = dayKey(now);
  return tasks.filter((t) => {
    if (t.archived_at) return false;
    if (!matchesTab(t, f.tab, now)) return false;
    if (f.pic !== "all" && t.pic !== f.pic) return false;
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.priority !== "all" && t.priority !== f.priority) return false;
    if (f.quick === "soon") {
      const diff = dueMs(t) - now;
      if (t.done || diff < 0 || diff > SOON_WINDOW_MS) return false;
    }
    if (f.quick === "done_today") {
      const d = doneMs(t);
      if (!t.done || d === null || dayKey(d) !== today) return false;
    }
    return matchesSearch(t, f.search);
  });
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  const copy = tasks.slice();
  if (sort === "deadline") copy.sort((a, b) => dueMs(a) - dueMs(b));
  else if (sort === "priority")
    copy.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || dueMs(a) - dueMs(b));
  else copy.sort((a, b) => createdMs(b) - createdMs(a));
  return copy;
}

export type GroupKey = "late" | "today" | "upcoming" | "done";
export interface TaskGroup {
  key: GroupKey;
  label: string;
  tasks: Task[];
}

/** Kelompokkan menurut keterlambatan, hari ini, mendatang, dan selesai. Grup kosong dibuang. */
export function groupTasks(tasks: Task[], now: number, sort: SortKey): TaskGroup[] {
  const today = dayKey(now);
  const late: Task[] = [];
  const todayList: Task[] = [];
  const upcoming: Task[] = [];
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.done) done.push(t);
    else if (dueMs(t) < now) late.push(t);
    else if (dayKey(dueMs(t)) === today) todayList.push(t);
    else upcoming.push(t);
  }
  done.sort((a, b) => (doneMs(b) ?? 0) - (doneMs(a) ?? 0));
  const groups: TaskGroup[] = [
    { key: "late", label: "Terlambat", tasks: sortTasks(late, sort) },
    { key: "today", label: "Hari ini", tasks: sortTasks(todayList, sort) },
    { key: "upcoming", label: "Mendatang", tasks: sortTasks(upcoming, sort) },
    { key: "done", label: "Selesai", tasks: done },
  ];
  return groups.filter((g) => g.tasks.length > 0);
}

export interface TeamRow {
  name: string;
  absent: boolean;
  open: number;
  inProgress: number;
  late: number;
  highLate: number;
  doneToday: number;
  onTime: number;
  onTimeSample: number;
  /** null bila sampel kurang dari MIN_SAMPLES. */
  onTimePct: number | null;
}

/** Beban kerja per PIC. Hanya menghitung fakta; tidak menilai kinerja dari jumlah tugas. */
export function teamStats(tasks: Task[], members: Member[], now: number): TeamRow[] {
  const today = dayKey(now);
  const names: string[] = [];
  for (const m of members) if (!m.archived_at && !names.includes(m.name)) names.push(m.name);
  for (const t of tasks) if (isOpen(t) && !names.includes(t.pic)) names.push(t.pic);

  const rows = new Map<string, TeamRow>();
  for (const n of names) {
    const m = members.find((x) => x.name === n);
    rows.set(n, {
      name: n,
      absent: !!m && m.absent_on === today,
      open: 0,
      inProgress: 0,
      late: 0,
      highLate: 0,
      doneToday: 0,
      onTime: 0,
      onTimeSample: 0,
      onTimePct: null,
    });
  }
  for (const t of tasks) {
    if (t.archived_at) continue;
    const r = rows.get(t.pic);
    if (!r) continue;
    if (t.done) {
      const d = doneMs(t);
      if (d === null) continue;
      if (dayKey(d) === today) r.doneToday++;
      if (d >= now - ONTIME_WINDOW_MS) {
        r.onTimeSample++;
        if (d <= dueMs(t)) r.onTime++;
      }
      continue;
    }
    r.open++;
    if (t.status === "in_progress") r.inProgress++;
    if (dueMs(t) < now) {
      r.late++;
      if (t.priority === "high") r.highLate++;
    }
  }
  for (const r of rows.values()) {
    r.onTimePct = r.onTimeSample >= MIN_SAMPLES ? Math.round((r.onTime / r.onTimeSample) * 100) : null;
  }
  return names.map((n) => rows.get(n)!);
}

/** Jobdesk yang perlu muncul sebagai banner peringatan sekarang. */
export function alertTasks(tasks: Task[], now: number, snoozed: Record<string, number>): Task[] {
  return tasks
    .filter(
      (t) =>
        isOpen(t) &&
        t.remind_enabled &&
        dueMs(t) - now <= t.remind_before_min * 60000 &&
        !((snoozed[t.id] ?? 0) > now),
    )
    .sort((a, b) => dueMs(a) - dueMs(b));
}

export function memberNames(members: Member[]): string[] {
  return members.filter((m) => !m.archived_at).map((m) => m.name);
}

export function isAbsentToday(members: Member[], name: string, now: number): boolean {
  const m = members.find((x) => x.name === name);
  return !!m && m.absent_on === dayKey(now);
}
