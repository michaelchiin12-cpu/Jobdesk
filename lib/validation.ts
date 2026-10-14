import type { LateReason, Priority, RepeatType, Status } from "./types";
import { LATE_REASON_LABEL } from "./types";
import { dayKey, parseLocalInput } from "./tz";

export type FieldErrors = Record<string, string>;

export interface TaskForm {
  title: string;
  note: string;
  pic: string;
  due: string; // nilai datetime-local, waktu WIB
  priority: Priority;
  status: Status;
  remindEnabled: boolean;
  remindBefore: string; // menit, sebagai teks dari input
  repeat: "none" | RepeatType;
}

export interface TaskCheck {
  errors: FieldErrors;
  warnings: string[];
  dueMs: number;
  remindBefore: number;
}

export const TITLE_MAX = 120;
export const NOTE_MAX = 1000;
export const LATE_NOTE_MAX = 500;

export function validateTaskForm(f: TaskForm, picNames: string[], now: number, isNew: boolean): TaskCheck {
  const errors: FieldErrors = {};
  const warnings: string[] = [];
  const title = f.title.trim();
  if (!title) errors.title = "Isi judul jobdesk.";
  else if (title.length > TITLE_MAX) errors.title = `Judul maksimal ${TITLE_MAX} karakter.`;
  if (f.note.length > NOTE_MAX) errors.note = `Catatan maksimal ${NOTE_MAX} karakter.`;
  if (!f.pic) errors.pic = "Pilih PIC.";
  else if (!picNames.includes(f.pic)) errors.pic = "PIC tidak ada di daftar tim.";

  const due = parseLocalInput(f.due);
  if (isNaN(due)) errors.due = "Isi tanggal dan jam deadline yang valid.";
  else if (isNew && due < now) warnings.push("Deadline sudah lewat. Jobdesk ini langsung berstatus terlambat.");

  const remind = Number(f.remindBefore);
  if (f.remindEnabled) {
    if (!Number.isInteger(remind) || remind < 1 || remind > 1440) {
      errors.remindBefore = "Isi menit pengingat antara 1 dan 1440.";
    }
  }
  if (!["high", "medium", "low"].includes(f.priority)) errors.priority = "Pilih prioritas.";
  if (!["todo", "in_progress", "waiting", "done"].includes(f.status)) errors.status = "Pilih status.";
  return { errors, warnings, dueMs: due, remindBefore: f.remindEnabled ? remind : 10 };
}

export interface TemplateForm {
  title: string;
  note: string;
  pic: string;
  priority: Priority;
  repeatType: RepeatType;
  weekday: string;
  monthDay: string;
  dueTime: string; // HH:MM WIB
  startsOn: string; // YYYY-MM-DD
  remindEnabled: boolean;
  remindBefore: string;
}

export function validateTemplateForm(f: TemplateForm, picNames: string[]): FieldErrors {
  const errors: FieldErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = "Isi judul template.";
  else if (title.length > TITLE_MAX) errors.title = `Judul maksimal ${TITLE_MAX} karakter.`;
  if (f.note.length > NOTE_MAX) errors.note = `Catatan maksimal ${NOTE_MAX} karakter.`;
  if (!f.pic) errors.pic = "Pilih PIC.";
  else if (!picNames.includes(f.pic)) errors.pic = "PIC tidak ada di daftar tim.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.dueTime)) errors.dueTime = "Isi jam deadline (HH:MM).";
  const startMs = Date.parse(f.startsOn + "T00:00:00+07:00");
  // Date.parse membulatkan tanggal yang tidak ada (31 Feb jadi 3 Mar), jadi cocokkan balik.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startsOn) || isNaN(startMs) || dayKey(startMs) !== f.startsOn) {
    errors.startsOn = "Isi tanggal mulai yang valid.";
  }
  if (f.repeatType === "weekly") {
    const w = Number(f.weekday);
    if (!Number.isInteger(w) || w < 1 || w > 7) errors.weekday = "Pilih hari dalam seminggu.";
  }
  if (f.repeatType === "monthly") {
    const d = Number(f.monthDay);
    if (!Number.isInteger(d) || d < 1 || d > 31) errors.monthDay = "Isi tanggal antara 1 dan 31.";
  }
  if (f.remindEnabled) {
    const r = Number(f.remindBefore);
    if (!Number.isInteger(r) || r < 1 || r > 1440) errors.remindBefore = "Isi menit pengingat antara 1 dan 1440.";
  }
  return errors;
}

export function validateLateReason(code: string, note: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!code) errors.reason = "Pilih alasan keterlambatan.";
  else if (!(code in LATE_REASON_LABEL)) errors.reason = "Alasan tidak dikenal.";
  if (note.length > LATE_NOTE_MAX) errors.note = `Catatan maksimal ${LATE_NOTE_MAX} karakter.`;
  return errors;
}

export const isLateReason = (v: string): v is LateReason => v in LATE_REASON_LABEL;
