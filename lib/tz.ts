// Seluruh tanggal dan jam ditampilkan dan dihitung dalam Asia/Jakarta (WIB, UTC+7),
// terlepas dari zona waktu browser. WIB tidak memakai waktu musim panas, jadi offset tetap.

export const TZ = "Asia/Jakarta";
export const OFFSET_MS = 7 * 3600 * 1000;
export const DAY_MS = 86400000;

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const DAYS_SHORT = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const pad = (n: number): string => (n < 10 ? "0" + n : String(n));

export interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  dow: number; // 0 = Minggu
}

export function parts(ms: number): Parts {
  const d = new Date(ms + OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

export function dayKey(ms: number): string {
  const p = parts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export const fmtTime = (ms: number): string => {
  const p = parts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
};

/** Awal hari (00:00 WIB) untuk kunci tanggal YYYY-MM-DD. */
export const dayStart = (key: string): number => Date.parse(`${key}T00:00:00+07:00`);

export function addDays(key: string, n: number): string {
  return dayKey(dayStart(key) + n * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
}

/** Senin pada minggu yang memuat tanggal tersebut. */
export function weekStart(key: string): string {
  const dow = parts(dayStart(key)).dow; // 0..6
  return addDays(key, -((dow + 6) % 7));
}

export function monthStart(key: string): string {
  return key.slice(0, 8) + "01";
}

export function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${pad(mm + 1)}-01`;
}

export function daysInMonth(key: string): number {
  const next = addMonths(monthStart(key), 1);
  return diffDays(monthStart(key), next);
}

const INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Nilai input datetime-local (dianggap waktu WIB) menjadi epoch ms; NaN jika tidak valid. */
export function parseLocalInput(v: string): number {
  if (!INPUT_RE.test(v)) return NaN;
  const ms = Date.parse(`${v}:00+07:00`);
  if (isNaN(ms)) return NaN;
  // tolak tanggal yang bergeser (mis. 31 Februari)
  return toLocalInput(ms) === v ? ms : NaN;
}

export function toLocalInput(ms: number): string {
  return `${dayKey(ms)}T${fmtTime(ms)}`;
}

export function dayLabel(ms: number, now: number): string {
  const k = dayKey(ms);
  const t = dayKey(now);
  if (k === t) return "Hari ini";
  if (k === addDays(t, 1)) return "Besok";
  if (k === addDays(t, -1)) return "Kemarin";
  const p = parts(ms);
  return `${DAYS_SHORT[p.dow]}, ${p.d} ${MONTHS_SHORT[p.m - 1]}`;
}

export function fmtDateTime(ms: number, now: number): string {
  return `${dayLabel(ms, now)} ${fmtTime(ms)}`;
}

export function fmtDateShort(ms: number): string {
  const p = parts(ms);
  return `${p.d} ${MONTHS_SHORT[p.m - 1]} ${p.y}`;
}

export function fmtDateLong(ms: number): string {
  const p = parts(ms);
  return `${DAYS[p.dow]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

export function fmtKeyShort(key: string): string {
  return fmtDateShort(dayStart(key));
}

export function monthLabel(key: string): string {
  const p = parts(dayStart(key));
  return `${MONTHS[p.m - 1]} ${p.y}`;
}

export function fmtCsv(ms: number | null): string {
  if (ms === null || isNaN(ms)) return "";
  return `${dayKey(ms)} ${fmtTime(ms)}`;
}

/** Waktu relatif: "terlambat 12 mnt", "3 j 5 mnt lagi". */
export function relText(diff: number): string {
  if (diff < 0) {
    const m = Math.ceil(-diff / 60000);
    if (m < 60) return `terlambat ${m} mnt`;
    const h = Math.floor(m / 60);
    if (h < 24) return `terlambat ${h} j ${m % 60} mnt`;
    return `terlambat ${Math.floor(h / 24)} hari`;
  }
  const m = Math.ceil(diff / 60000);
  if (m < 60) return `${m} mnt lagi`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} j ${m % 60} mnt lagi`;
  return `${Math.floor(h / 24)} hari lagi`;
}

export function mmss(diff: number): string {
  const s = Math.max(0, Math.ceil(diff / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} mnt`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} j ${m % 60} mnt`;
  const d = Math.floor(h / 24);
  return `${d} hari ${h % 24} j`;
}

export function relPast(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 45_000) return "baru saja";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} j lalu`;
  return `${dayLabel(ms, now)} ${fmtTime(ms)}`;
}
