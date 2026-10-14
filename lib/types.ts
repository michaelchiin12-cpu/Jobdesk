export type Role = "lead" | "cs";
export type Priority = "high" | "medium" | "low";
export type Status = "todo" | "in_progress" | "waiting" | "done";
export type RepeatType = "daily" | "weekdays" | "weekly" | "monthly";
export type LateReason =
  | "high_workload"
  | "waiting_info"
  | "system_issue"
  | "priority_changed"
  | "bad_estimate"
  | "other";

export interface Task {
  id: string;
  title: string;
  pic: string;
  due_at: string;
  note: string | null;
  priority: Priority;
  status: Status;
  done: boolean;
  done_at: string | null;
  started_at: string | null;
  original_due_at: string | null;
  original_pic: string | null;
  late_reason: LateReason | null;
  late_note: string | null;
  remind_enabled: boolean;
  remind_before_min: number;
  template_id: string | null;
  occurrence_date: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  archived_at: string | null;
}

export interface Member {
  id: string;
  name: string;
  absent_on: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface Template {
  id: string;
  title: string;
  note: string | null;
  pic: string;
  priority: Priority;
  repeat_type: RepeatType;
  weekday: number | null;
  month_day: number | null;
  due_time: string;
  remind_enabled: boolean;
  remind_before_min: number;
  starts_on: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  archived_at: string | null;
}

export type EventAction =
  | "created"
  | "pic_changed"
  | "due_changed"
  | "priority_changed"
  | "status_changed"
  | "completed"
  | "reopened"
  | "archived"
  | "restored"
  | "late_reason_set"
  | "became_late";

export interface TaskEvent {
  id: number;
  task_id: string | null;
  task_title: string;
  action: EventAction;
  actor: string;
  old_value: string | null;
  new_value: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export type NotifKind =
  | "reminder"
  | "overdue"
  | "assigned"
  | "task_changed"
  | "lead_overdue"
  | "digest_morning"
  | "digest_evening";

export type PushState =
  | "pending"
  | "queued"
  | "sent"
  | "partial"
  | "failed"
  | "no_subscribers"
  | "not_configured"
  | "unconfirmed";

export interface AppNotification {
  id: number;
  kind: NotifKind;
  task_id: string | null;
  audience: "all" | "pic" | "lead";
  audience_pic: string | null;
  title: string;
  body: string;
  urgent: boolean;
  push_state: PushState;
  push_sent: number;
  push_failed: number;
  created_at: string;
}

export interface AppSettings {
  cs_can_manage: boolean;
  lead_escalation: boolean;
  escalation_minutes: number;
  digests_enabled: boolean;
  digest_morning: string;
  digest_evening: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  cs_can_manage: false,
  lead_escalation: true,
  escalation_minutes: 15,
  digests_enabled: true,
  digest_morning: "08:30",
  digest_evening: "17:30",
};

export interface SchedulerStatus {
  last_run: string | null;
  cron_job: boolean;
  push_configured: boolean;
}

export const STATUS_LABEL: Record<Status, string> = {
  todo: "Belum mulai",
  in_progress: "Dalam proses",
  waiting: "Menunggu",
  done: "Selesai",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const REPEAT_LABEL: Record<RepeatType | "none", string> = {
  none: "Tidak berulang",
  daily: "Setiap hari",
  weekdays: "Hari kerja (Sen-Jum)",
  weekly: "Setiap minggu",
  monthly: "Setiap bulan",
};

export const LATE_REASON_LABEL: Record<LateReason, string> = {
  high_workload: "Beban kerja tinggi",
  waiting_info: "Menunggu informasi atau konfirmasi",
  system_issue: "Kendala sistem",
  priority_changed: "Prioritas pekerjaan berubah",
  bad_estimate: "Estimasi waktu kurang tepat",
  other: "Alasan lainnya",
};

export const WEEKDAY_LABEL = ["", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

export const NOTIF_KIND_LABEL: Record<NotifKind, string> = {
  reminder: "Pengingat sebelum deadline",
  overdue: "Deadline terlewat",
  assigned: "Jobdesk baru untuk saya",
  task_changed: "Perubahan jobdesk saya",
  lead_overdue: "Prioritas tinggi terlambat (CS Lead)",
  digest_morning: "Ringkasan pagi",
  digest_evening: "Ringkasan akhir hari",
};

export const PUSH_STATE_LABEL: Record<PushState, string> = {
  pending: "Menunggu dikirim",
  queued: "Dalam antrean",
  sent: "Diterima layanan push",
  partial: "Sebagian diterima",
  failed: "Gagal dikirim",
  no_subscribers: "Belum ada perangkat berlangganan",
  not_configured: "Pengiriman push belum dikonfigurasi",
  unconfirmed: "Belum terkonfirmasi",
};
