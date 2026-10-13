"use client";

import { useEffect, useRef, useState } from "react";
import type { Member, Task } from "@/lib/types";
import { SOON_MS, dayKey, dayLabel, dueMs, fmtTime, isAbsent, relText } from "@/lib/time";
import PicSelect from "./PicSelect";

interface Props {
  tasks: Task[];
  members: Member[];
  loaded: boolean;
  now: number;
  canWrite: boolean;
  onToggle: (t: Task, done: boolean) => void;
  onReassign: (t: Task, pic: string) => void;
  onDelete: (t: Task) => void;
}

interface RowProps {
  t: Task;
  members: Member[];
  now: number;
  canWrite: boolean;
  confirmDelete: boolean;
  onToggle: (t: Task, done: boolean) => void;
  onReassign: (t: Task, pic: string) => void;
  onDelete: (t: Task) => void;
}

function TaskRow({ t, members, now, canWrite, confirmDelete, onToggle, onReassign, onDelete }: RowProps) {
  const due = dueMs(t);
  const today = dayKey(now);
  const st = t.done ? "done" : due < now ? "late" : due - now <= SOON_MS ? "soon" : "later";
  const absent = !t.done && isAbsent(members, t.pic, today);
  return (
    <li className={"row st-" + st + (t.done ? " is-done" : "")}>
      <label className="chk">
        <input
          type="checkbox"
          checked={t.done}
          disabled={!canWrite}
          aria-label={"Tandai selesai: " + t.title}
          onChange={(e) => onToggle(t, e.target.checked)}
        />
        <span />
      </label>
      <div>
        <div className="row-title">{t.title}</div>
        <div className="row-meta">
          <span className="pic">PIC {t.pic}</span>
          <span className="mono">{dayLabel(due, now)} {fmtTime(due)}</span>
          {t.done ? (
            <span>selesai {fmtTime(t.done_at ? Date.parse(t.done_at) : due)}</span>
          ) : (
            <span className="rel">{relText(due - now)}</span>
          )}
          {t.repeat === "daily" && <span className="tag">Tiap hari</span>}
          {t.repeat === "weekdays" && <span className="tag">Hari kerja</span>}
        </div>
        {t.note && <div className="row-note">{t.note}</div>}
      </div>
      <div className="row-side">
        {absent && <span className="pill absent">PIC tidak masuk</span>}
        {st === "late" && <span className="pill late">Terlambat</span>}
        {st === "soon" && <span className="pill soon">Segera</span>}
        {st === "done" && <span className="pill done">Selesai</span>}
        {!t.done && (
          <PicSelect
            current={t.pic}
            members={members}
            today={today}
            disabled={!canWrite}
            onPick={(p) => onReassign(t, p)}
          />
        )}
        <button
          type="button"
          className={"btn small" + (confirmDelete ? " danger" : "")}
          disabled={!canWrite}
          onClick={() => onDelete(t)}
        >
          {confirmDelete ? "Yakin hapus?" : "Hapus"}
        </button>
      </div>
    </li>
  );
}

export default function TaskList({ tasks, members, loaded, now, canWrite, onToggle, onReassign, onDelete }: Props) {
  const [filter, setFilter] = useState("all");
  const [showDone, setShowDone] = useState(false);
  const [delId, setDelId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const names: string[] = [];
  members.forEach((m) => {
    if (!names.includes(m.name)) names.push(m.name);
  });
  tasks.forEach((t) => {
    if (t.pic && !names.includes(t.pic)) names.push(t.pic);
  });
  const activeFilter = filter === "all" || names.includes(filter) ? filter : "all";
  const today = dayKey(now);

  function requestDelete(t: Task) {
    if (delId === t.id) {
      setDelId(null);
      onDelete(t);
      return;
    }
    setDelId(t.id);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDelId(null), 3500);
  }

  const rowProps = (t: Task) => (
    <TaskRow
      key={t.id}
      t={t}
      members={members}
      now={now}
      canWrite={canWrite}
      confirmDelete={delId === t.id}
      onToggle={onToggle}
      onReassign={onReassign}
      onDelete={requestDelete}
    />
  );

  let body: React.ReactNode;
  if (!loaded) {
    body = <p className="hint">Memuat jobdesk...</p>;
  } else if (tasks.length === 0) {
    body = (
      <div className="empty">
        <h2>Belum ada jobdesk</h2>
        <p className="hint">
          Semua anggota tim yang membuka papan ini melihat daftar yang sama, langsung saat ada perubahan.
        </p>
        <ol>
          <li>{members.length === 0 ? 'Tambahkan nama anggota tim di panel "Tim hari ini".' : "Anggota tim sudah terdaftar."}</li>
          <li>Isi jobdesk, PIC, dan tenggat di form sebelah kiri.</li>
          <li>
            Sepuluh menit sebelum tenggat, jobdesk yang belum dicentang muncul sebagai peringatan di semua PC lengkap
            dengan nama PIC.
          </li>
        </ol>
      </div>
    );
  } else {
    const items = tasks.filter((t) => activeFilter === "all" || t.pic === activeFilter);
    const pending = items.filter((t) => !t.done).sort((a, b) => dueMs(a) - dueMs(b));
    const done = items
      .filter((t) => t.done)
      .sort((a, b) => (b.done_at ? Date.parse(b.done_at) : 0) - (a.done_at ? Date.parse(a.done_at) : 0));
    const groups: [string, string, Task[]][] = [
      ["late", "Terlambat", pending.filter((t) => dueMs(t) < now)],
      ["soon", "Tenggat 10 menit ke depan", pending.filter((t) => dueMs(t) >= now && dueMs(t) - now <= SOON_MS)],
      ["today", "Hari ini", pending.filter((t) => dueMs(t) - now > SOON_MS && dayKey(dueMs(t)) === today)],
      ["later", "Mendatang", pending.filter((t) => dueMs(t) - now > SOON_MS && dayKey(dueMs(t)) !== today)],
    ];
    body = (
      <>
        {groups
          .filter((g) => g[2].length)
          .map((g) => (
            <section key={g[0]} className={"group " + g[0]}>
              <h2 className="group-h">
                {g[1]} <b>{g[2].length}</b>
              </h2>
              <ul className="rows">{g[2].map(rowProps)}</ul>
            </section>
          ))}
        {pending.length === 0 && (
          <div className="empty">
            <h2>Semua jobdesk selesai</h2>
            <p className="hint">Tidak ada yang tertunda{activeFilter === "all" ? "" : " untuk " + activeFilter}.</p>
          </div>
        )}
        {done.length > 0 &&
          (showDone ? (
            <>
              <section className="group">
                <h2 className="group-h">
                  Selesai <b>{done.length}</b>
                </h2>
                <ul className="rows">{done.slice(0, 20).map(rowProps)}</ul>
              </section>
              <button type="button" className="btn small more" onClick={() => setShowDone(false)}>
                Sembunyikan yang selesai
              </button>
            </>
          ) : (
            <button type="button" className="btn small more" onClick={() => setShowDone(true)}>
              Tampilkan yang selesai ({done.length})
            </button>
          ))}
      </>
    );
  }

  return (
    <>
      {names.length > 0 && (
        <div className="toolbar">
          <button type="button" className="chip" aria-pressed={activeFilter === "all"} onClick={() => setFilter("all")}>
            Semua
          </button>
          {names.map((n) => (
            <button key={n} type="button" className="chip" aria-pressed={activeFilter === n} onClick={() => setFilter(n)}>
              {n}
              {isAbsent(members, n, today) ? " (tidak masuk)" : ""}
            </button>
          ))}
        </div>
      )}
      {body}
    </>
  );
}
