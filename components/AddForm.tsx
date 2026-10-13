"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Member, NewTask, Repeat } from "@/lib/types";
import { dayKey, isAbsent, toInputValue } from "@/lib/time";

interface Props {
  members: Member[];
  disabled: boolean;
  onAdd: (t: NewTask) => Promise<boolean>;
}

const PRESETS: [string, number][] = [
  ["+15 mnt", 15],
  ["+30 mnt", 30],
  ["+1 jam", 60],
  ["+2 jam", 120],
];

export default function AddForm({ members, disabled, onAdd }: Props) {
  const [title, setTitle] = useState("");
  const [pic, setPic] = useState("");
  const [due, setDue] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDue(toInputValue(Math.ceil((Date.now() + 3600000) / 300000) * 300000));
  }, []);

  useEffect(() => {
    if (members.length && !members.some((m) => m.name === pic)) setPic(members[0].name);
    if (!members.length && pic) setPic("");
  }, [members, pic]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    const dueMsVal = due ? new Date(due).getTime() : NaN;
    if (!t) return setMsg("Isi nama jobdesk dulu.");
    if (!pic) return setMsg("Pilih PIC. Tambahkan anggota tim jika daftarnya kosong.");
    if (isNaN(dueMsVal)) return setMsg("Isi tanggal dan jam tenggat.");
    setMsg("");
    setBusy(true);
    const ok = await onAdd({ title: t, pic, due_at: new Date(dueMsVal).toISOString(), note: note.trim(), repeat });
    setBusy(false);
    if (ok) {
      setTitle("");
      setNote("");
    }
  }

  const today = dayKey(Date.now());
  const off = disabled || busy;

  return (
    <form className="card" onSubmit={submit} noValidate>
      <h2 className="card-h">Jobdesk baru</h2>
      <div className="field">
        <label className="lbl" htmlFor="f-title">Jobdesk</label>
        <input
          id="f-title"
          type="text"
          maxLength={120}
          autoComplete="off"
          placeholder="Contoh: Balas komentar Instagram"
          value={title}
          disabled={off}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="lbl" htmlFor="f-pic">PIC</label>
        <select id="f-pic" value={pic} disabled={off || !members.length} onChange={(e) => setPic(e.target.value)}>
          {!members.length && <option value="">Tambahkan anggota tim dulu</option>}
          {members.map((m) => (
            <option key={m.id} value={m.name}>
              {m.name}
              {isAbsent(members, m.name, today) ? " (tidak masuk)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="f-due">Tenggat</label>
        <input id="f-due" type="datetime-local" value={due} disabled={off} onChange={(e) => setDue(e.target.value)} />
        <div className="presets">
          {PRESETS.map(([label, min]) => (
            <button
              key={min}
              type="button"
              className="btn small"
              disabled={off}
              onClick={() => setDue(toInputValue(Date.now() + min * 60000))}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="f-repeat">Ulangi</label>
        <select id="f-repeat" value={repeat} disabled={off} onChange={(e) => setRepeat(e.target.value as Repeat)}>
          <option value="none">Tidak diulang</option>
          <option value="daily">Setiap hari</option>
          <option value="weekdays">Setiap hari kerja (Sen-Jum)</option>
        </select>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="f-note">Catatan (opsional)</label>
        <textarea
          id="f-note"
          rows={2}
          maxLength={300}
          placeholder="Detail yang perlu diketahui PIC"
          value={note}
          disabled={off}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {msg && <p className="msg" role="alert">{msg}</p>}
      <button className="btn primary block" type="submit" disabled={off}>
        {busy ? "Menyimpan..." : "Tambah jobdesk"}
      </button>
    </form>
  );
}
