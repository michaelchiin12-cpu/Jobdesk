import type { Member, Repeat, Task } from "./types";

export const SOON_MS = 10 * 60 * 1000;
export const SNOOZE_MS = 2 * 60 * 1000;
export const KEEP_DONE_MS = 14 * 24 * 60 * 60 * 1000;

const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const pad = (n: number): string => (n < 10 ? "0" + n : String(n));

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export function dayLabel(ms: number, now: number): string {
  const k = dayKey(ms);
  if (k === dayKey(now)) return "Hari ini";
  if (k === dayKey(now + 86400000)) return "Besok";
  if (k === dayKey(now - 86400000)) return "Kemarin";
  const d = new Date(ms);
  return DAYS[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()];
}

export function todayLong(ms: number): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(ms));
  } catch {
    const d = new Date(ms);
    return DAYS[d.getDay()] + ", " + d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }
}

/** Nilai untuk input datetime-local (waktu lokal browser). */
export function toInputValue(ms: number): string {
  const d = new Date(ms);
  return (
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "T" + pad(d.getHours()) + ":" + pad(d.getMinutes())
  );
}

export function relText(diff: number): string {
  if (diff < 0) {
    const m = Math.ceil(-diff / 60000);
    if (m < 60) return "terlambat " + m + " mnt";
    const h = Math.floor(m / 60);
    if (h < 24) return "terlambat " + h + " j " + (m % 60) + " mnt";
    return "terlambat " + Math.floor(h / 24) + " hari";
  }
  const m = Math.ceil(diff / 60000);
  if (m < 60) return m + " mnt lagi";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " j " + (m % 60) + " mnt lagi";
  return Math.floor(h / 24) + " hari lagi";
}

export function mmss(diff: number): string {
  const s = Math.max(0, Math.ceil(diff / 1000));
  return pad(Math.floor(s / 60)) + ":" + pad(s % 60);
}

/** Tenggat berikutnya untuk jobdesk berulang; selalu di masa depan. */
export function nextDue(dueMs: number, repeat: Repeat, nowMs: number): number {
  const d = new Date(dueMs);
  let n = 0;
  do {
    d.setDate(d.getDate() + 1);
    n++;
  } while (
    ((repeat === "weekdays" && (d.getDay() === 0 || d.getDay() === 6)) || d.getTime() <= nowMs) &&
    n < 400
  );
  return d.getTime();
}

export const dueMs = (t: Task): number => Date.parse(t.due_at);

export function isAbsent(members: Member[], name: string, today: string): boolean {
  const m = members.find((x) => x.name === name);
  return !!m && m.absent_on === today;
}
