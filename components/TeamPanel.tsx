"use client";

import { useState } from "react";
import { Avatar } from "./ui";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import * as api from "@/lib/api";
import { MIN_SAMPLES, teamStats } from "@/lib/tasks";

export default function TeamPanel({ now, activePic, onPic }: { now: number; activePic: string; onPic: (name: string) => void }) {
  const d = useData();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = teamStats(d.tasks, d.members, now);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    const r = await api.addMember(name);
    setBusy(false);
    if (!r.ok) return toast(r.error, true);
    setName("");
    toast(`${r.data.name} ditambahkan ke tim.`);
    void d.refresh();
  }
  async function absent(id: string, value: boolean) {
    const r = await api.setAbsent(id, value, now);
    if (!r.ok) return toast(r.error, true);
    void d.refresh();
  }
  async function remove(id: string, n: string) {
    if (!confirm(`Hapus ${n} dari daftar PIC? Jobdesk lama tetap tersimpan.`)) return;
    const r = await api.archiveMember(id);
    if (!r.ok) return toast(r.error, true);
    void d.refresh();
  }

  return (
    <section className="panel" aria-label="Beban kerja tim">
      <div className="panel-head"><h2>Tim hari ini</h2></div>
      {rows.length === 0 && <p className="hint" style={{ color: "var(--faint)" }}>Belum ada anggota tim. Tambahkan anggota agar bisa dipilih sebagai PIC.</p>}
      {rows.map((r) => {
        const m = d.members.find((x) => x.name === r.name);
        return (
          <div className="member" key={r.name}>
            <Avatar name={r.name} size={32} />
            <div>
              <div className="m-name">
                <button className="t-title" onClick={() => onPic(activePic === r.name ? "all" : r.name)} aria-pressed={activePic === r.name} style={{ color: activePic === r.name ? "var(--teal)" : undefined }}>{r.name}</button>
                {r.absent && <span className="tag">Tidak masuk</span>}
              </div>
              <div className="m-stats">
                <span>{r.open} aktif</span>
                <span>{r.inProgress} diproses</span>
                <span className={r.late ? "bad" : ""}>{r.late} terlambat{r.highLate ? ` (${r.highLate} High)` : ""}</span>
                <span>{r.doneToday} selesai hari ini</span>
                <span>{r.onTimePct === null ? `Tepat waktu: butuh ${MIN_SAMPLES}+ data` : `Tepat waktu 7 hari: ${r.onTimePct}%`}</span>
              </div>
              {r.absent && r.open > 0 && <p className="hint" style={{ color: "var(--orange)", marginTop: 4 }}>{r.open} jobdesk belum selesai. Alihkan ke PIC lain.</p>}
              {d.canManage && m && (
                <div className="m-actions">
                  <button className="btn sm ghost" onClick={() => absent(m.id, !r.absent)}>{r.absent ? "Tandai masuk" : "Tandai tidak masuk"}</button>
                  <button className="btn sm ghost" onClick={() => remove(m.id, r.name)}>Hapus</button>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {d.canManage && (
        <form onSubmit={(e) => { e.preventDefault(); void add(); }} style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input type="text" placeholder="Nama anggota baru" aria-label="Nama anggota baru" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button className="btn" type="submit" disabled={busy || !name.trim()}>Tambah</button>
        </form>
      )}
    </section>
  );
}
