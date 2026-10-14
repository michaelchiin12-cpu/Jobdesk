import type { Task } from "./types";
import { LATE_REASON_LABEL, PRIORITY_LABEL, STATUS_LABEL } from "./types";
import { doneMs, dueMs } from "./tasks";
import { OUTCOME_LABEL, outcomeOf } from "./metrics";
import { fmtCsv } from "./tz";

/** Cegah sel yang diawali rumus agar tidak dieksekusi saat dibuka di spreadsheet. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

export const TASK_CSV_HEADERS = [
  "Judul",
  "PIC",
  "PIC awal",
  "Prioritas",
  "Status",
  "Hasil",
  "Deadline awal",
  "Deadline terbaru",
  "Dibuat",
  "Mulai",
  "Selesai",
  "Alasan keterlambatan",
  "Catatan alasan",
  "Catatan",
];

export function taskCsvRows(tasks: Task[], now: number): (string | null)[][] {
  return tasks.map((t) => [
    t.title,
    t.pic,
    t.original_pic ?? t.pic,
    PRIORITY_LABEL[t.priority],
    STATUS_LABEL[t.status],
    OUTCOME_LABEL[outcomeOf(t, now)],
    fmtCsv(t.original_due_at ? Date.parse(t.original_due_at) : dueMs(t)),
    fmtCsv(dueMs(t)),
    fmtCsv(Date.parse(t.created_at)),
    fmtCsv(t.started_at ? Date.parse(t.started_at) : null),
    fmtCsv(doneMs(t)),
    t.late_reason ? LATE_REASON_LABEL[t.late_reason] : "",
    t.late_note ?? "",
    t.note ?? "",
  ]);
}
