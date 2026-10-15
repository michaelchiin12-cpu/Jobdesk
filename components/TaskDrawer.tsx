"use client";

import { useMemo, useState } from "react";
import { Field, Modal } from "./ui";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import * as api from "@/lib/api";
import { memberNames } from "@/lib/tasks";
import { validateTaskForm, TITLE_MAX, NOTE_MAX, type TaskForm } from "@/lib/validation";
import { parseLocalInput, toLocalInput, dayKey, addDays } from "@/lib/tz";
import type { Priority, RepeatType, Status, Task } from "@/lib/types";
import { PRIORITY_LABEL, REPEAT_LABEL, STATUS_LABEL } from "@/lib/types";

export interface Prefill { title?: string; note?: string; pic?: string; priority?: Priority; }

export default function TaskDrawer({
  task, prefill, onClose, onSaved,
}: { task: Task | null; prefill?: Prefill; onClose: () => void; onSaved?: (t: Task | null) => void }) {
  const d = useData();
  const toast = useToast();
  const names = memberNames(d.members);
  const isNew = !task;
  const readOnly = !d.canManage;
  const now = Date.now();

  const [f, setF] = useState<TaskForm>(() => ({
    title: task?.title ?? prefill?.title ?? "",
    note: task?.note ?? prefill?.note ?? "",
    pic: task?.pic ?? prefill?.pic ?? "",
    due: task ? toLocalInput(Date.parse(task.due_at)) : `${addDays(dayKey(now), 0)}T17:00`,
    priority: task?.priority ?? prefill?.priority ?? "medium",
    status: task?.status ?? "todo",
    remindEnabled: task?.remind_enabled ?? true,
    remindBefore: String(task?.remind_before_min ?? 10),
    repeat: "none",
  }));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState("");
  const picList = useMemo(() => (task && !names.includes(task.pic) ? [task.pic, ...names] : names), [names, task]);
  const check = validateTaskForm(f, picList, now, isNew);
  const set = <K extends keyof TaskForm>(k: K, v: TaskForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const err = (k: string) => (touched ? check.errors[k] : undefined);

  async function save() {
    setTouched(true);
    if (Object.keys(check.errors).length) return;
    setBusy(true);
    setServerErr("");
    const dueIso = new Date(check.dueMs).toISOString();
    if (isNew && f.repeat !== "none") {
      const base = api.templateFromDeadline(check.dueMs);
      const r = await api.createTemplate({
        title: f.title, note: f.note, pic: f.pic, priority: f.priority, repeat_type: f.repeat as RepeatType,
        weekday: f.repeat === "weekly" ? base.weekday : null,
        month_day: f.repeat === "monthly" ? base.month_day : null,
        due_time: base.due_time, starts_on: base.starts_on,
        remind_enabled: f.remindEnabled, remind_before_min: check.remindBefore,
      }, d.actor);
      setBusy(false);
      if (!r.ok) return setServerErr(r.error);
      toast("Jadwal berulang dibuat. Jobdesk muncul otomatis sesuai jadwal.");
      void d.refresh();
      onSaved?.(null);
      return onClose();
    }
    const base = {
      title: f.title.trim(), note: f.note, pic: f.pic, due_at: dueIso, priority: f.priority,
      remind_enabled: f.remindEnabled, remind_before_min: check.remindBefore,
    };
    const r = isNew
      ? await d.createTask({ ...base, status: f.status })
      : await d.editTask(task.id, { ...base, status: f.status, done: f.status === "done" });
    setBusy(false);
    if (!r.ok) return setServerErr(r.error);
    toast(isNew ? "Jobdesk ditambahkan." : "Perubahan disimpan.");
    onSaved?.(r.data);
    onClose();
  }

  return (
    <Modal
      title={isNew ? "Tambah jobdesk" : readOnly ? "Detail jobdesk" : "Ubah jobdesk"}
      variant="drawer"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>{readOnly ? "Tutup" : "Batal"}</button>
          {!readOnly && <button className="btn primary" onClick={save} disabled={busy}>{busy ? "Menyimpan..." : isNew ? "Tambah jobdesk" : "Simpan perubahan"}</button>}
        </>
      }
    >
      {readOnly && <p className="banner-info" style={{ marginTop: 0, marginBottom: 14 }}>Akun Tim CS hanya bisa mengubah status. Minta CS Lead untuk mengubah isi jobdesk.</p>}
      <Field label="Judul" error={err("title")} htmlFor="f-title">
        <input id="f-title" type="text" value={f.title} maxLength={TITLE_MAX + 20} onChange={(e) => set("title", e.target.value)} disabled={readOnly} data-autofocus />
      </Field>
      <Field label="Catatan" error={err("note")} htmlFor="f-note" hint={`${f.note.length}/${NOTE_MAX}`}>
        <textarea id="f-note" value={f.note} onChange={(e) => set("note", e.target.value)} disabled={readOnly} />
      </Field>
      <div className="row2">
        <Field label="PIC" error={err("pic")} htmlFor="f-pic">
          <select id="f-pic" value={f.pic} onChange={(e) => set("pic", e.target.value)} disabled={readOnly}>
            <option value="">Pilih PIC</option>
            {picList.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label="Prioritas" error={err("priority")} htmlFor="f-pr">
          <select id="f-pr" value={f.priority} onChange={(e) => set("priority", e.target.value as Priority)} disabled={readOnly}>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </select>
        </Field>
      </div>
      <div className="row2">
        <Field label="Deadline (WIB)" error={err("due")} htmlFor="f-due">
          <input id="f-due" type="datetime-local" value={f.due} onChange={(e) => set("due", e.target.value)} disabled={readOnly} />
        </Field>
        <Field label="Status" error={err("status")} htmlFor="f-st">
          <select id="f-st" value={f.status} onChange={(e) => set("status", e.target.value as Status)} disabled={d.role === null}>
            {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </Field>
      </div>
      {touched && check.warnings.map((w) => <p key={w} className="warn-box">{w}</p>)}
      <div className="field">
        <label className="check"><input type="checkbox" checked={f.remindEnabled} onChange={(e) => set("remindEnabled", e.target.checked)} disabled={readOnly} />Ingatkan sebelum deadline</label>
        {f.remindEnabled && (
          <div className="field" style={{ marginTop: 8, maxWidth: 220 }}>
            <label htmlFor="f-rem">Menit sebelum deadline</label>
            <input id="f-rem" type="number" min={1} max={1440} value={f.remindBefore} onChange={(e) => set("remindBefore", e.target.value)} disabled={readOnly} />
            {err("remindBefore") && <p className="err" role="alert">{err("remindBefore")}</p>}
          </div>
        )}
      </div>
      {isNew ? (
        <>
          <Field label="Pengulangan" htmlFor="f-rep" hint={f.repeat === "none" ? undefined : "Jobdesk berikutnya dibuat otomatis sesuai jadwal, pada jam deadline di atas."}>
            <select id="f-rep" value={f.repeat} onChange={(e) => set("repeat", e.target.value as TaskForm["repeat"])}>
              {(Object.keys(REPEAT_LABEL) as (RepeatType | "none")[]).map((r) => <option key={r} value={r}>{REPEAT_LABEL[r]}</option>)}
            </select>
          </Field>
          {f.repeat === "weekly" && !isNaN(parseLocalInput(f.due)) && (
            <p className="hint" style={{ marginBottom: 12 }}>Diulang tiap minggu pada hari yang sama dengan deadline.</p>
          )}
        </>
      ) : task.template_id ? (
        <p className="hint">Jobdesk ini dibuat dari jadwal berulang. Ubah jadwalnya di halaman Template.</p>
      ) : null}
      {serverErr && <p className="msg" role="alert">{serverErr}</p>}
    </Modal>
  );
}
