import type { RepeatType } from "./types";
import { addDays, daysInMonth, dayStart, monthStart, parts } from "./tz";

/** Cermin template_occurs_on di database. Tanggal bulanan yang tidak ada dipindah ke akhir bulan. */
export function occursOn(type: RepeatType, weekday: number | null, monthDay: number | null, key: string): boolean {
  const p = parts(dayStart(key));
  const iso = p.dow === 0 ? 7 : p.dow;
  switch (type) {
    case "daily": return true;
    case "weekdays": return iso >= 1 && iso <= 5;
    case "weekly": return iso === weekday;
    case "monthly": return monthDay !== null && p.d === Math.min(monthDay, daysInMonth(monthStart(key)));
  }
}

/** Beberapa tanggal berikutnya (YYYY-MM-DD) mulai dari `from`, paling awal `startsOn`. */
export function nextDates(type: RepeatType, weekday: number | null, monthDay: number | null, from: string, startsOn: string, n = 4): string[] {
  const out: string[] = [];
  let k = from > startsOn ? from : startsOn;
  for (let i = 0; i < 400 && out.length < n; i++, k = addDays(k, 1)) {
    if (occursOn(type, weekday, monthDay, k)) out.push(k);
  }
  return out;
}
