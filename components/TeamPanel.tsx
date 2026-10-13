"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Member, Task } from "@/lib/types";
import { dayKey } from "@/lib/time";

interface Props {
  members: Member[];
  tasks: Task[];
  loaded: boolean;
  now: number;
  canWrite: boolean;
  onAdd: (name: string) => Promise<boolean>;
  onToggleAbsent: (m: Member) => void;
  onRemove: (m: Member) => void;
}

export default function TeamPanel({ members, tasks, loaded, now, canWrite, onAdd, onToggleAbsent, onRemove }: Props) {
  const [name, setName] = useState("");
  const [rmId, setRmId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const today = dayKey(now);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const counts: Record<string, number> = {};
  tasks.forEach((t) => {
    if (!t.done) counts[t.pic] = (counts[t.pic] || 0) + 1;
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (await onAdd(n)) setName("");
  }

  function remove(m: Member) {
    if (rmId === m.id) {
      setRmId(null);
      onRemove(m);
      return;
    }
    setRmId(m.id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRmId(null), 3500);
  }

  return (
    <section className="card">
      <h2 className="card-h">Tim hari ini</h2>
      {!loaded ? (
        <p className="hint">Memuat tim...</p>
      ) : members.length === 0 ? (
        <p className="hint">Belum ada anggota. Tambahkan nama setiap orang yang memegang jobdesk.</p>
      ) : (
        <>
          <p className="hint">
            Tandai &quot;Tidak masuk&quot; agar jobdesk orang itu ditandai dan bisa dialihkan. Tanda ini hilang otomatis besok.
          </p>
          <ul className="team">
            {members.map((m) => {
              const out = m.absent_on === today;
              return (
                <li key={m.id}>
                  <span className={"tdot" + (out ? " out" : "")} />
                  <span className="tname">
                    {m.name} <span className="tcount">{counts[m.name] || 0} belum selesai</span>
                  </span>
                  <button
                    type="button"
                    className="switch"
                    aria-pressed={out}
                    disabled={!canWrite}
                    onClick={() => onToggleAbsent(m)}
                  >
                    Tidak masuk
                  </button>
                  <button
                    type="button"
                    className={"btn small" + (rmId === m.id ? " danger" : "")}
                    disabled={!canWrite}
                    onClick={() => remove(m)}
                  >
                    {rmId === m.id ? "Yakin?" : "Hapus"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <form className="team-form" onSubmit={submit} noValidate>
        <input
          type="text"
          maxLength={40}
          autoComplete="off"
          placeholder="Nama anggota"
          aria-label="Nama anggota baru"
          value={name}
          disabled={!canWrite}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn" type="submit" disabled={!canWrite}>Tambah</button>
      </form>
    </section>
  );
}
