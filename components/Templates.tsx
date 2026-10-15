"use client";

import { useState } from "react";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import { Avatar, Empty, Field, Modal } from "./ui";
import * as api from "@/lib/api";
import { memberNames } from "@/lib/tasks";
import { nextDates } from "@/lib/recurrence";
import { validateTemplateForm, type TemplateForm, TITLE_MAX, NOTE_MAX } from "@/lib/validation";
import { dayKey, dayStart, fmtDateShort } from "@/lib/tz";
import type { Priority, RepeatType, Template } from "@/lib/types";
import { PRIORITY_LABEL, WEEKDAY_LABEL } from "@/lib/types";

const PRESETS: { label: string; f: Partial<TemplateForm> }[] = [
  { label: "Rekap harian", f: { title: "Rekap harian CS", repeatType: "weekdays", dueTime: "17:00", priority: "medium" } },
  { label: "Cek inbox pagi", f: { title: "Cek inbox dan komentar pagi", repeatType: "weekdays", dueTime: "09:30", priority: "high" } },
  { label: "Laporan mingguan", f: { title: "Laporan mingguan CS", repeatType: "weekly", weekday: "5", dueTime: "16:00", priority: "medium" } },
  { label: "Evaluasi bulanan", f: { title: "Evaluasi bulanan tim", repeatType: "monthly", monthDay: "25", dueTime: "15:00", priority: "low" } },
];

const REPEAT_OPTS: { v: RepeatType; l: string }[] = [
  { v: "daily", l: "Setiap hari" }, { v: "weekdays", l: "Hari kerja (Sen-Jum)" }, { v: "weekly", l: "Setiap minggu" }, { v: "monthly", l: "Setiap bulan" },
];

export const describeRepeat = (t: { repeat_type: RepeatType; weekday: number | null; month_day: number | null; due_time: string }) => {
  const at = `jam ${t.due_time.slice(0, 5)} WIB`;
  if (t.repeat_type === "daily") return `Setiap hari, ${at}`;
  if (t.repeat_type === "weekdays") return `Senin sampai Jumat, ${at}`;
  if (t.repeat_type === "weekly") return `Setiap ${WEEKDAY_LABEL[t.weekday ?? 1]}, ${at}`;
  return `Setiap tanggal ${t.month_day}, ${at}`;
};

function TemplateDialog({ tpl, preset, onClose }: { tpl: Template | null; preset?: Partial<TemplateForm>; onClose: () => void }) {
  const d = useData();
  const toast = useToast();
  const names = memberNames(d.members);
  const today = dayKey(Date.now());
  const [f, setF] = useState<TemplateForm>(() => ({
    title: tpl?.title ?? "", note: tpl?.note ?? "", pic: tpl?.pic ?? "", priority: tpl?.priority ?? "medium",
    repeatType: tpl?.repeat_type ?? "weekdays", weekday: String(tpl?.weekday ?? 1), monthDay: String(tpl?.month_day ?? 1),
    dueTime: tpl?.due_time.slice(0, 5) ?? "17:00", startsOn: tpl?.starts_on ?? today,
    remindEnabled: tpl?.remind_enabled ?? true, remindBefore: String(tpl?.remind_before_min ?? 10),
    ...preset,
  }));
  const [touched, setTouched] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState("");
  const picList = tpl && !names.includes(tpl.pic) ? [tpl.pic, ...names] : names;
  const errors = validateTemplateForm(f, picList);
  const e = (k: string) => (touched ? errors[k] : undefined);
  const set = <K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const preview = Object.keys(errors).length === 0 || (!errors.weekday && !errors.monthDay && !errors.startsOn)
    ? nextDates(f.repeatType, f.repeatType === "weekly" ? Number(f.weekday) : null, f.repeatType === "monthly" ? Number(f.monthDay) : null, today, f.startsOn || today, 4)
    : [];

  async function save() {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    const body: api.NewTemplate = {
      title: f.title, note: f.note, pic: f.pic, priority: f.priority, repeat_type: f.repeatType,
      weekday: f.repeatType === "weekly" ? Number(f.weekday) : null,
      month_day: f.repeatType === "monthly" ? Number(f.monthDay) : null,
      due_time: f.dueTime, starts_on: f.startsOn,
      remind_enabled: f.remindEnabled, remind_before_min: f.remindEnabled ? Number(f.remindBefore) : 10,
    };
    const r = tpl ? await api.updateTemplate(tpl.id, body, d.actor, applyOpen) : await api.createTemplate(body, d.actor);
    setBusy(false);
    if (!r.ok) return setServerErr(r.error);
    toast(tpl ? "Template diperbarui." : "Template dibuat. Jobdesk muncul otomatis sesuai jadwal.");
    void d.refresh();
    onClose();
  }

  return (
    <Modal title={tpl ? "Ubah template" : "Template baru"} variant="drawer" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Batal</button><button className="btn primary" onClick={save} disabled={busy}>{busy ? "Menyimpan..." : "Simpan template"}</button></>}>
      <Field label="Judul" error={e("title")} htmlFor="t-title"><input id="t-title" type="text" value={f.title} maxLength={TITLE_MAX + 20} onChange={(x) => set("title", x.target.value)} data-autofocus /></Field>
      <Field label="Catatan" error={e("note")} htmlFor="t-note" hint={`${f.note.length}/${NOTE_MAX}`}><textarea id="t-note" value={f.note} onChange={(x) => set("note", x.target.value)} /></Field>
      <div className="row2">
        <Field label="PIC" error={e("pic")} htmlFor="t-pic">
          <select id="t-pic" value={f.pic} onChange={(x) => set("pic", x.target.value)}><option value="">Pilih PIC</option>{picList.map((n) => <option key={n} value={n}>{n}</option>)}</select>
        </Field>
        <Field label="Prioritas" htmlFor="t-pr">
          <select id="t-pr" value={f.priority} onChange={(x) => set("priority", x.target.value as Priority)}>{(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select>
        </Field>
      </div>
      <div className="row2">
        <Field label="Pengulangan" htmlFor="t-rep">
          <select id="t-rep" value={f.repeatType} onChange={(x) => set("repeatType", x.target.value as RepeatType)}>{REPEAT_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
        </Field>
        {f.repeatType === "weekly" && (
          <Field label="Hari" error={e("weekday")} htmlFor="t-wd"><select id="t-wd" value={f.weekday} onChange={(x) => set("weekday", x.target.value)}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{WEEKDAY_LABEL[n]}</option>)}</select></Field>
        )}
        {f.repeatType === "monthly" && (
          <Field label="Tanggal" error={e("monthDay")} htmlFor="t-md" hint="Bila bulan lebih pendek, dipindah ke hari terakhir."><input id="t-md" type="number" min={1} max={31} value={f.monthDay} onChange={(x) => set("monthDay", x.target.value)} /></Field>
        )}
      </div>
      <div className="row2">
        <Field label="Jam deadline (WIB)" error={e("dueTime")} htmlFor="t-time"><input id="t-time" type="time" value={f.dueTime} onChange={(x) => set("dueTime", x.target.value)} /></Field>
        <Field label="Mulai tanggal" error={e("startsOn")} htmlFor="t-start"><input id="t-start" type="date" value={f.startsOn} onChange={(x) => set("startsOn", x.target.value)} /></Field>
      </div>
      <div className="field">
        <label className="check"><input type="checkbox" checked={f.remindEnabled} onChange={(x) => set("remindEnabled", x.target.checked)} />Ingatkan sebelum deadline</label>
        {f.remindEnabled && (
          <div className="field" style={{ marginTop: 8, maxWidth: 220 }}>
            <label htmlFor="t-rem">Menit sebelum deadline</label>
            <input id="t-rem" type="number" min={1} max={1440} value={f.remindBefore} onChange={(x) => set("remindBefore", x.target.value)} />
            {e("remindBefore") && <p className="err" role="alert">{e("remindBefore")}</p>}
          </div>
        )}
      </div>
      {preview.length > 0 && <p className="hint" style={{ marginBottom: 12 }}>Jobdesk berikutnya: {preview.map((k) => fmtDateShort(dayStart(k))).join(", ")}</p>}
      {tpl && (
        <label className="check" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={applyOpen} onChange={(x) => setApplyOpen(x.target.checked)} />
          Terapkan juga ke jobdesk dari template ini yang belum selesai
        </label>
      )}
      {serverErr && <p className="msg" role="alert">{serverErr}</p>}
    </Modal>
  );
}

function StopDialog({ tpl, onClose }: { tpl: Template; onClose: () => void }) {
  const d = useData();
  const toast = useToast();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const r = await api.stopTemplate(tpl.id, archiveOpen, d.actor);
    setBusy(false);
    if (!r.ok) return toast(r.error, true);
    toast(`Pengulangan "${tpl.title}" dihentikan.`);
    void d.refresh();
    onClose();
  }
  return (
    <Modal title="Hentikan pengulangan" variant="dialog" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Batal</button><button className="btn danger" onClick={go} disabled={busy}>Hentikan pengulangan</button></>}>
      <p style={{ marginBottom: 12 }}>&ldquo;{tpl.title}&rdquo; tidak akan dibuat lagi. Jobdesk yang sudah ada tetap tersimpan.</p>
      <label className="check"><input type="checkbox" checked={archiveOpen} onChange={(e) => setArchiveOpen(e.target.checked)} />Arsipkan jobdesk dari template ini yang belum dimulai dan belum jatuh tempo</label>
    </Modal>
  );
}

export default function Templates() {
  const d = useData();
  const toast = useToast();
  const [edit, setEdit] = useState<{ tpl: Template | null; preset?: Partial<TemplateForm> } | null>(null);
  const [stop, setStop] = useState<Template | null>(null);

  if (!d.canManage) {
    return <div className="page-head"><div><h1>Template</h1><p className="sub">Hanya CS Lead yang bisa mengatur jobdesk berulang.</p></div></div>;
  }

  async function toggle(t: Template) {
    const r = await api.updateTemplate(t.id, { active: !t.active }, d.actor, false);
    if (!r.ok) return toast(r.error, true);
    toast(t.active ? "Template dijeda." : "Template diaktifkan.");
    void d.refresh();
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Template jobdesk berulang</h1><p className="sub">Jobdesk dibuat otomatis sesuai jadwal. Tidak ada duplikat meski dasbor dibuka di banyak perangkat.</p></div>
        <div className="page-actions"><button className="btn primary" onClick={() => setEdit({ tpl: null })}>+ Template baru</button></div>
      </div>
      <div className="presets" aria-label="Contoh awal">
        {PRESETS.map((p) => <button key={p.label} className="btn sm" onClick={() => setEdit({ tpl: null, preset: p.f })}>{p.label}</button>)}
      </div>
      {d.templates.length === 0 ? (
        <Empty title="Belum ada template" body="Contoh di atas hanya mengisi formulir. Anda tetap memilih PIC dan jadwalnya." />
      ) : (
        <div className="tpl-grid">
          {d.templates.map((t) => (
            <article key={t.id} className={`tpl${t.active ? "" : " off"}`}>
              <h3>{t.title}</h3>
              <p className="meta"><span>{describeRepeat(t)}</span></p>
              <p className="meta"><span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Avatar name={t.pic} size={18} />{t.pic}</span><span className={`badge pr-${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>{!t.active && <span className="badge">Dijeda</span>}</p>
              <p className="hint" style={{ color: "var(--faint)" }}>Berikutnya: {t.active ? nextDates(t.repeat_type, t.weekday, t.month_day, dayKey(Date.now()), t.starts_on, 2).map((k) => fmtDateShort(dayStart(k))).join(", ") || "-" : "dijeda"}</p>
              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <button className="btn sm" onClick={() => setEdit({ tpl: t })}>Ubah</button>
                <button className="btn sm ghost" onClick={() => toggle(t)}>{t.active ? "Jeda" : "Aktifkan"}</button>
                <button className="btn sm ghost" onClick={() => setStop(t)}>Hentikan</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {edit && <TemplateDialog key={edit.tpl?.id ?? "new"} tpl={edit.tpl} preset={edit.preset} onClose={() => setEdit(null)} />}
      {stop && <StopDialog tpl={stop} onClose={() => setStop(null)} />}
    </>
  );
}
