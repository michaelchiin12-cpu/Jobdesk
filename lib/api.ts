// Lapisan data: satu-satunya tempat yang berbicara dengan Supabase.
// UI memanggil fungsi di sini dan menerima Result, tidak pernah memegang query mentah.
import type { PostgrestError } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import type {
  AppNotification, AppSettings, LateReason, Member, Priority, RepeatType, Role, SchedulerStatus,
  Status, Task, TaskEvent, Template,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { DAY_MS, dayKey, parts } from "./tz";

export type Result<T = void> = { ok: true; data: T } | { ok: false; error: string; code?: string };

type AnyErr = Partial<PostgrestError> & { message?: string; code?: string };

export function explainError(e: AnyErr | unknown): { message: string; code?: string } {
  const err = (e ?? {}) as AnyErr;
  const code = err.code;
  const msg = String(err.message ?? "");
  if (code === "42501" || /row-level security|permission denied|Akses ditolak|hanya boleh|Hanya CS Lead/i.test(msg)) {
    return { code, message: "Akun ini tidak punya izin untuk tindakan itu." };
  }
  if (code === "23505") return { code, message: "Data dengan nama atau jadwal yang sama sudah ada." };
  if (code === "23514") return { code, message: "Isi data tidak memenuhi aturan. Periksa judul, prioritas, dan pengingat." };
  if (code === "42703" || code === "42P01" || code === "PGRST202" || code === "PGRST204" || code === "PGRST205") {
    return { code, message: "Database belum diperbarui. Jalankan supabase/schema.sql di Supabase." };
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return { code, message: "Tidak ada koneksi ke server. Periksa internet lalu coba lagi." };
  }
  return { code, message: "Perubahan belum tersimpan. Coba lagi sebentar." };
}

async function guard<T>(fn: () => PromiseLike<{ data: T | null; error: AnyErr | null }>, fallback?: T): Promise<Result<T>> {
  try {
    const { data, error } = await fn();
    if (error) {
      const x = explainError(error);
      return { ok: false, error: x.message, code: x.code };
    }
    return { ok: true, data: (data ?? fallback) as T };
  } catch (e) {
    const x = explainError(e);
    return { ok: false, error: x.message, code: x.code };
  }
}

function sb() {
  const c = getSupabase();
  if (!c) throw new Error("Supabase belum dikonfigurasi");
  return c;
}

const DONE_KEEP_MS = 14 * DAY_MS;
export const TASK_LIMIT = 1000;

/* ---------- baca ---------- */

export const myRole = () => guard<Role | null>(() => sb().rpc("my_role"));

export function fetchTasks(now = Date.now()) {
  const since = new Date(now - DONE_KEEP_MS).toISOString();
  return guard<Task[]>(
    () =>
      sb()
        .from("tasks")
        .select("*")
        .is("archived_at", null)
        .or(`done.eq.false,done_at.gte.${since}`)
        .order("due_at", { ascending: false })
        .limit(TASK_LIMIT),
    [],
  );
}

export const fetchMembers = () =>
  guard<Member[]>(() => sb().from("team_members").select("*").is("archived_at", null).order("created_at"), []);

export const fetchTemplates = () =>
  guard<Template[]>(
    () => sb().from("task_templates").select("*").is("archived_at", null).order("created_at"),
    [],
  );

export const fetchEvents = (limit = 40) =>
  guard<TaskEvent[]>(() => sb().from("task_events").select("*").order("id", { ascending: false }).limit(limit), []);

export const fetchNotifications = (limit = 40) =>
  guard<AppNotification[]>(
    () => sb().from("notifications").select("*").order("id", { ascending: false }).limit(limit),
    [],
  );

export const fetchArchived = () =>
  guard<Task[]>(
    () => sb().from("tasks").select("*").not("archived_at", "is", null).order("archived_at", { ascending: false }).limit(100),
    [],
  );

export async function fetchSettings(): Promise<Result<AppSettings>> {
  const r = await guard<{ key: string; value: unknown }[]>(() => sb().from("app_settings").select("key,value"), []);
  if (!r.ok) return r;
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const row of r.data) s[row.key] = row.value;
  return { ok: true, data: s as unknown as AppSettings };
}

export const schedulerStatus = () => guard<SchedulerStatus>(() => sb().rpc("scheduler_status"));

/** Ambil semua tugas untuk laporan (berhalaman, 1000 baris per permintaan, maksimal 10.000). */
export async function fetchReportTasks(from: number, to: number, rangeFrom: number): Promise<Result<{ tasks: Task[]; truncated: boolean }>> {
  const f = new Date(from).toISOString();
  const t = new Date(to).toISOString();
  const rf = new Date(rangeFrom).toISOString();
  const page = 1000;
  const max = 10;
  const all: Task[] = [];
  for (let i = 0; i < max; i++) {
    const r = await guard<Task[]>(
      () =>
        sb()
          .from("tasks")
          .select("*")
          .is("archived_at", null)
          .or(`and(due_at.gte.${f},due_at.lt.${t}),and(created_at.gte.${rf},created_at.lt.${t}),and(done_at.gte.${f},done_at.lt.${t})`)
          .order("id")
          .range(i * page, i * page + page - 1),
      [],
    );
    if (!r.ok) return r;
    all.push(...r.data);
    if (r.data.length < page) return { ok: true, data: { tasks: all, truncated: false } };
  }
  return { ok: true, data: { tasks: all, truncated: true } };
}

/* ---------- jobdesk ---------- */

export interface NewTask {
  title: string;
  note: string;
  pic: string;
  due_at: string;
  priority: Priority;
  status: Status;
  remind_enabled: boolean;
  remind_before_min: number;
}

export const insertTask = (t: NewTask, actor: string) =>
  guard<Task>(() => sb().from("tasks").insert({ ...t, title: t.title.trim(), updated_by: actor }).select().single());

export type TaskPatch = Partial<
  Pick<Task, "title" | "note" | "pic" | "due_at" | "priority" | "status" | "done" | "remind_enabled" | "remind_before_min" | "late_reason" | "late_note" | "archived_at">
>;

export const updateTask = (id: string, patch: TaskPatch, actor: string) =>
  guard<Task>(() => sb().from("tasks").update({ ...patch, updated_by: actor }).eq("id", id).select().single());

export const setLateReason = (id: string, reason: LateReason, note: string, actor: string) =>
  updateTask(id, { late_reason: reason, late_note: note.trim() || null }, actor);

/* ---------- anggota tim ---------- */

export async function addMember(name: string): Promise<Result<Member>> {
  const clean = name.trim();
  const r = await guard<Member>(() => sb().from("team_members").insert({ name: clean }).select().single());
  if (r.ok || r.code !== "23505") return r;
  // Nama sudah ada: mungkin anggota lama yang dinonaktifkan. Aktifkan kembali.
  return guard<Member>(() =>
    sb().from("team_members").update({ archived_at: null }).eq("name", clean).select().single(),
  );
}

export const setAbsent = (id: string, absent: boolean, now = Date.now()) =>
  guard<Member>(() =>
    sb().from("team_members").update({ absent_on: absent ? dayKey(now) : null }).eq("id", id).select().single(),
  );

export const archiveMember = (id: string) =>
  guard<Member>(() =>
    sb().from("team_members").update({ archived_at: new Date().toISOString() }).eq("id", id).select().single(),
  );

/* ---------- template ---------- */

export interface NewTemplate {
  title: string;
  note: string;
  pic: string;
  priority: Priority;
  repeat_type: RepeatType;
  weekday: number | null;
  month_day: number | null;
  due_time: string;
  starts_on: string;
  remind_enabled: boolean;
  remind_before_min: number;
}

export const generateRecurring = () => guard<number>(() => sb().rpc("generate_recurring_tasks", { p_horizon_days: 1 }));

export async function createTemplate(t: NewTemplate, actor: string): Promise<Result<Template>> {
  const r = await guard<Template>(() =>
    sb().from("task_templates").insert({ ...t, title: t.title.trim(), created_by: actor, updated_by: actor }).select().single(),
  );
  if (r.ok) await generateRecurring(); // tugas pertama muncul seketika bila masuk jendela hari ini/besok
  return r;
}

export async function updateTemplate(id: string, patch: Partial<NewTemplate> & { active?: boolean }, actor: string, applyToOpen: boolean): Promise<Result<{ template: Template; updatedTasks: number }>> {
  const r = await guard<Template>(() =>
    sb().from("task_templates").update({ ...patch, updated_by: actor }).eq("id", id).select().single(),
  );
  if (!r.ok) return r;
  let updatedTasks = 0;
  if (applyToOpen) {
    const a = await guard<number>(() => sb().rpc("apply_template_to_open_tasks", { p_template: id, p_actor: actor }));
    if (!a.ok) return a;
    updatedTasks = a.data ?? 0;
  }
  await generateRecurring();
  return { ok: true, data: { template: r.data, updatedTasks } };
}

export const stopTemplate = (id: string, archiveOpen: boolean, actor: string) =>
  guard<number>(() => sb().rpc("stop_template", { p_template: id, p_archive_open: archiveOpen, p_actor: actor }));

/* ---------- pengaturan ---------- */

export const saveSetting = (key: keyof AppSettings, value: unknown) =>
  guard<unknown>(() => sb().from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() }).select());

/* ---------- langganan push ---------- */

export const saveSubscription = (sub: { endpoint: string; p256dh: string; auth: string }, member: string | null, kinds: string[], ua: string) =>
  guard<null>(() =>
    sb().rpc("upsert_push_subscription", {
      p_endpoint: sub.endpoint, p_p256dh: sub.p256dh, p_auth: sub.auth, p_member: member, p_kinds: kinds, p_ua: ua,
    }),
  );

export const removeSubscription = (endpoint: string) =>
  guard<null>(() => sb().rpc("remove_push_subscription", { p_endpoint: endpoint }));

export const getSubscription = (endpoint: string) =>
  guard<{ member_name: string | null; kinds: string[]; last_success_at: string | null } | null>(() =>
    sb().rpc("get_my_push_subscription", { p_endpoint: endpoint }),
  );

/** Tanggal mulai yang masuk akal untuk template dari sebuah deadline. */
export function templateFromDeadline(dueMs: number) {
  const p = parts(dueMs);
  const pad = (n: number) => (n < 10 ? "0" + n : String(n));
  return {
    starts_on: dayKey(dueMs),
    due_time: `${pad(p.h)}:${pad(p.mi)}`,
    weekday: p.dow === 0 ? 7 : p.dow, // isodow: Senin=1 ... Minggu=7
    month_day: p.d,
  };
}
