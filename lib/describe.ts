import type { LateReason, Priority, Status, TaskEvent } from "./types";
import { LATE_REASON_LABEL, PRIORITY_LABEL, STATUS_LABEL } from "./types";
import { fmtDateTime } from "./tz";

const st = (v: string | null) => (v && v in STATUS_LABEL ? STATUS_LABEL[v as Status] : v ?? "-");
const pr = (v: string | null) => (v && v in PRIORITY_LABEL ? PRIORITY_LABEL[v as Priority] : v ?? "-");

export type EventTone = "teal" | "red" | "green" | "blue" | "orange" | "muted";

/** Kalimat riwayat yang bisa dibaca CS Lead tanpa melihat data mentah. */
export function describeEvent(e: TaskEvent, now: number): { text: string; tone: EventTone } {
  const t = `"${e.task_title}"`;
  switch (e.action) {
    case "created":
      return { text: `${e.actor} membuat ${t} untuk ${e.new_value ?? "-"}`, tone: "teal" };
    case "pic_changed":
      return { text: `${e.actor} memindahkan ${t} dari ${e.old_value ?? "-"} ke ${e.new_value ?? "-"}`, tone: "blue" };
    case "due_changed": {
      const a = e.old_value ? fmtDateTime(Date.parse(e.old_value), now) : "-";
      const b = e.new_value ? fmtDateTime(Date.parse(e.new_value), now) : "-";
      return { text: `${e.actor} mengubah deadline ${t} dari ${a} ke ${b}`, tone: "orange" };
    }
    case "priority_changed":
      return { text: `${e.actor} mengubah prioritas ${t} dari ${pr(e.old_value)} ke ${pr(e.new_value)}`, tone: "orange" };
    case "status_changed":
      return { text: `${e.actor} mengubah status ${t} dari ${st(e.old_value)} ke ${st(e.new_value)}`, tone: "blue" };
    case "completed":
      return { text: `${e.actor} menyelesaikan ${t}`, tone: "green" };
    case "reopened":
      return { text: `${e.actor} membuka kembali ${t}`, tone: "blue" };
    case "archived":
      return { text: `${e.actor} mengarsipkan ${t}`, tone: "muted" };
    case "restored":
      return { text: `${e.actor} memulihkan ${t} dari arsip`, tone: "teal" };
    case "late_reason_set": {
      const code = e.new_value as LateReason | null;
      const label = code && code in LATE_REASON_LABEL ? LATE_REASON_LABEL[code] : e.new_value ?? "-";
      return { text: `${e.actor} mencatat alasan terlambat ${t}: ${label}`, tone: "red" };
    }
    case "became_late":
      return { text: `${t} milik ${e.new_value ?? "-"} melewati deadline`, tone: "red" };
    default:
      return { text: `${e.actor} mengubah ${t}`, tone: "muted" };
  }
}
