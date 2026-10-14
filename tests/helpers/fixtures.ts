import type { Member, Task } from "../../lib/types";

/** Rabu 14 Oktober 2026, 10:00 WIB. */
export const NOW = Date.parse("2026-10-14T10:00:00+07:00");
/** Epoch ms untuk jam WIB pada hari relatif terhadap NOW (0 = hari ini). */
export const at = (hhmm: string, dayOffset = 0): number =>
  Date.parse(`2026-10-${String(14 + dayOffset).padStart(2, "0")}T${hhmm}:00+07:00`);
export const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
export function mk(over: Partial<Task> & { due: number; done_ms?: number | null; created_ms?: number }): Task {
  const { due, done_ms, created_ms, ...rest } = over;
  const done = rest.done ?? (done_ms !== undefined && done_ms !== null);
  seq++;
  return {
    id: `t${seq}`,
    title: `Tugas ${seq}`,
    pic: "Ani",
    due_at: iso(due),
    note: null,
    priority: "medium",
    status: done ? "done" : "todo",
    done,
    done_at: done ? iso(done_ms ?? due) : null,
    started_at: null,
    original_due_at: iso(due),
    original_pic: "Ani",
    late_reason: null,
    late_note: null,
    remind_enabled: true,
    remind_before_min: 10,
    template_id: null,
    occurrence_date: null,
    created_at: iso(created_ms ?? at("08:00", -1)),
    updated_at: iso(NOW),
    updated_by: null,
    archived_at: null,
    ...rest,
  };
}

export const member = (name: string, over: Partial<Member> = {}): Member => ({
  id: `m-${name}`, name, absent_on: null, archived_at: null, created_at: iso(NOW), ...over,
});
