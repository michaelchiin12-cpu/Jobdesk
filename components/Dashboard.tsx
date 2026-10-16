"use client";

import { useEffect, useMemo, useState } from "react";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import TaskDrawer from "./TaskDrawer";
import LateReasonDialog from "./LateReasonDialog";
import TeamPanel from "./TeamPanel";
import ActivityPanel from "./ActivityPanel";
import AlertCenter from "./AlertCenter";
import { Avatar, DeadlineBadge, Empty, Modal, PriorityBadge } from "./ui";
import { useNow } from "@/lib/now";
import {
  applyFilters, dashStats, DEFAULT_FILTERS, dueMs, groupTasks, isAbsentToday, matchesTab, memberNames,
  TAB_LABEL, urgency, type Filters, type Tab,
} from "@/lib/tasks";
import * as api from "@/lib/api";
import { fmtDateTime, relPast } from "@/lib/tz";
import type { Priority, Status, Task } from "@/lib/types";
import { LATE_REASON_LABEL, PRIORITY_LABEL, STATUS_LABEL } from "@/lib/types";

/* ---------- baris jobdesk ---------- */
function TaskRow({ t, now, onOpen, onStatus, onArchive, onLate }: {
  t: Task; now: number; onOpen: (t: Task) => void; onStatus: (t: Task, s: Status) => void; onArchive: (t: Task) => void; onLate: (t: Task) => void;
}) {
  const d = useData();
  const u = urgency(t, now);
  const [menu, setMenu] = useState(false);
  const absent = isAbsentToday(d.members, t.pic, now);
  return (
    <li className={`task u-${u} s-${t.status}${t.done ? " is-done" : ""}`}>
      <div className="t-check">
        <input type="checkbox" checked={t.done} onChange={() => onStatus(t, t.done ? "todo" : "done")} aria-label={t.done ? `Buka kembali ${t.title}` : `Selesaikan ${t.title}`} />
      </div>
      <div className="t-body">
        <button className="t-title" onClick={() => onOpen(t)}>{t.title}</button>
        <div className="t-meta">
          <span className="pic"><Avatar name={t.pic} size={20} />{t.pic}{absent && !t.done && <span className="absent-tag">tidak masuk</span>}</span>
          <span>{t.done && t.done_at ? `Selesai ${fmtDateTime(Date.parse(t.done_at), now)}` : fmtDateTime(dueMs(t), now)}</span>
          {t.original_pic && t.original_pic !== t.pic && <span title="PIC awal">dari {t.original_pic}</span>}
          {t.template_id && <span className="badge rpt">Berulang</span>}
          {t.late_reason && <span className="badge dl-late" title={t.late_note ?? undefined}>{LATE_REASON_LABEL[t.late_reason]}</span>}
        </div>
        {t.note && <p className="t-note">{t.note}</p>}
      </div>
      <div className="t-side">
        <DeadlineBadge urgency={u} diff={dueMs(t) - now} />
        <PriorityBadge priority={t.priority} />
        <select value={t.status} onChange={(e) => onStatus(t, e.target.value as Status)} aria-label={`Status ${t.title}`}>
          {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <div className="menu-wrap">
          <button className="icon-btn" aria-label={`Aksi ${t.title}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} onBlur={() => setTimeout(() => setMenu(false), 150)}>⋯</button>
          {menu && (
            <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); onOpen(t); }}>{d.canManage ? "Ubah jobdesk" : "Lihat detail"}</button>
              {t.done && t.late_reason === null && dueMs(t) < Date.parse(t.done_at ?? "") && <button role="menuitem" onClick={() => { setMenu(false); onLate(t); }}>Catat alasan terlambat</button>}
              {d.canManage && <button role="menuitem" onClick={() => { setMenu(false); onArchive(t); }}>Arsipkan</button>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/* ---------- arsip ---------- */
function ArchiveDialog({ onClose }: { onClose: () => void }) {
  const d = useData();
  const toast = useToast();
  const [list, setList] = useState<Task[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.fetchArchived().then((r) => (r.ok ? setList(r.data) : setErr(r.error))); }, []);
  async function restore(t: Task) {
    const r = await d.editTask(t.id, { archived_at: null });
    if (!r.ok) return toast(r.error, true);
    setList((l) => (l ?? []).filter((x) => x.id !== t.id));
    toast("Jobdesk dipulihkan.");
  }
  return (
    <Modal title="Jobdesk diarsipkan" onClose={onClose} variant="drawer">
      {err && <p className="msg">{err}</p>}
      {list === null && !err && <p className="hint">Memuat...</p>}
      {list?.length === 0 && <Empty title="Arsip kosong" body="Jobdesk yang diarsipkan muncul di sini dan bisa dipulihkan." />}
      {list?.map((t) => (
        <div key={t.id} className="notif" style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
          <div><b>{t.title}</b><small>{t.pic} · {t.archived_at ? relPast(Date.parse(t.archived_at), Date.now()) : ""}</small></div>
          <button className="btn sm" onClick={() => restore(t)}>Pulihkan</button>
        </div>
      ))}
    </Modal>
  );
}

/* ---------- halaman ---------- */
export default function Dashboard() {
  const d = useData();
  const toast = useToast();
  const now = useNow(1000) || Date.now();
  const listNow = useNow(20000) || now;
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const [drawer, setDrawer] = useState<{ task: Task | null } | null>(null);
  const [lateFor, setLateFor] = useState<Task | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [q, setQ] = useState("");
  const [showDone, setShowDone] = useState(false);
  useEffect(() => {
    try { setShowDone(localStorage.getItem("jobdesk.showDone") === "1"); } catch { /* abaikan */ }
  }, []);
  const toggleDone = () => setShowDone((v) => {
    try { localStorage.setItem("jobdesk.showDone", v ? "0" : "1"); } catch { /* abaikan */ }
    return !v;
  });

  useEffect(() => {
    const id = setTimeout(() => setF((x) => ({ ...x, search: q })), 200);
    return () => clearTimeout(id);
  }, [q]);

  const stats = useMemo(() => dashStats(d.tasks, listNow), [d.tasks, listNow]);
  const filtered = useMemo(() => applyFilters(d.tasks, f, listNow), [d.tasks, f, listNow]);
  const groups = useMemo(() => groupTasks(filtered, listNow, f.sort), [filtered, listNow, f.sort]);
  const counts = useMemo(() => {
    const live = d.tasks.filter((t) => !t.archived_at);
    const c = {} as Record<Tab, number>;
    (Object.keys(TAB_LABEL) as Tab[]).forEach((k) => { c[k] = live.filter((t) => matchesTab(t, k, listNow)).length; });
    return c;
  }, [d.tasks, listNow]);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));
  const active = f.pic !== "all" || f.status !== "all" || f.priority !== "all" || f.quick !== null || f.search !== "";
  const reset = () => { setF({ ...DEFAULT_FILTERS, tab: f.tab, sort: f.sort }); setQ(""); };

  async function changeStatus(t: Task, s: Status) {
    const wasLate = !t.done && dueMs(t) < Date.now();
    const r = await d.editTask(t.id, { status: s, done: s === "done" });
    if (!r.ok) return toast(r.error, true);
    if (s === "done") {
      toast(`"${t.title}" selesai.`);
      if (wasLate && !r.data.late_reason) setLateFor(r.data);
    } else if (t.done) toast("Jobdesk dibuka kembali.");
  }
  async function archive(t: Task) {
    const r = await d.editTask(t.id, { archived_at: new Date().toISOString() });
    if (!r.ok) return toast(r.error, true);
    toast(`"${t.title}" diarsipkan.`);
  }

  const cards: { key: string; label: string; n: number; sub: string; color: string; on: () => void; pressed: boolean }[] = [
    { key: "today", label: "Hari ini", n: stats.todayTotal, sub: "deadline hari ini", color: "var(--teal)", on: () => setF({ ...DEFAULT_FILTERS, tab: "today" }), pressed: f.tab === "today" && !f.quick },
    { key: "late", label: "Terlambat", n: stats.late, sub: "belum selesai, lewat deadline", color: "var(--red)", on: () => setF({ ...DEFAULT_FILTERS, tab: "late" }), pressed: f.tab === "late" },
    { key: "soon", label: "Segera", n: stats.soon, sub: "deadline dalam 1 jam", color: "var(--orange)", on: () => setF({ ...DEFAULT_FILTERS, quick: "soon" }), pressed: f.quick === "soon" },
    { key: "done", label: "Selesai hari ini", n: stats.doneToday, sub: "diselesaikan hari ini", color: "var(--green)", on: () => setF({ ...DEFAULT_FILTERS, quick: "done_today", tab: "done" }), pressed: f.quick === "done_today" },
  ];

  const names = memberNames(d.members);

  return (
    <>
      <AlertCenter now={now} onDone={(t) => changeStatus(t, "done")} onProgress={(t) => changeStatus(t, "in_progress")} />
      {d.loadError && (
        <div className="banner-err" role="alert">
          <span>{d.loadError} {d.loaded ? "Data di layar mungkin belum terbaru." : ""}</span>
          <button className="btn sm" onClick={() => void d.refresh()}>Coba lagi</button>
        </div>
      )}
      {d.conn === "polling" && <p className="banner-info">Koneksi realtime terputus. Data tetap diperbarui tiap 30 detik.</p>}
      {d.conn === "offline" && <p className="banner-err" role="status">Anda offline. Perubahan baru tersimpan setelah internet kembali.</p>}

      <section className="stats" aria-label="Ringkasan">
        {cards.map((c) => (
          <button key={c.key} className="stat" style={{ ["--c" as string]: c.color }} aria-pressed={c.pressed} onClick={c.on}>
            <span className="s-label">{c.label}</span>
            <span className="s-num">{d.loaded ? c.n : "-"}</span>
            <span className="s-sub">{c.sub}</span>
          </button>
        ))}
      </section>

      <div className="layout">
        <main>
          <div className="tabs" role="tablist" aria-label="Filter jobdesk">
            {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={f.tab === k && !f.quick} className={`tab${k === "late" ? " late" : ""}`} onClick={() => setF((x) => ({ ...x, tab: k, quick: null }))}>
                {TAB_LABEL[k]}<span className="n">{d.loaded ? counts[k] : ""}</span>
              </button>
            ))}
          </div>
          <div className="toolbar">
            <input className="search" type="search" placeholder="Cari judul, catatan, atau PIC" aria-label="Cari jobdesk" value={q} onChange={(e) => setQ(e.target.value)} />
            <select aria-label="Filter PIC" value={f.pic} onChange={(e) => set("pic", e.target.value)}>
              <option value="all">Semua PIC</option>
              {names.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select aria-label="Filter status" value={f.status} onChange={(e) => set("status", e.target.value as Filters["status"])}>
              <option value="all">Semua status</option>
              {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
            <select aria-label="Filter prioritas" value={f.priority} onChange={(e) => set("priority", e.target.value as Filters["priority"])}>
              <option value="all">Semua prioritas</option>
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select>
            <select aria-label="Urutkan" value={f.sort} onChange={(e) => set("sort", e.target.value as Filters["sort"])}>
              <option value="deadline">Deadline terdekat</option>
              <option value="priority">Prioritas tertinggi</option>
              <option value="created">Terbaru dibuat</option>
            </select>
            {d.canManage && <button className="btn primary" onClick={() => setDrawer({ task: null })}>+ Tambah jobdesk</button>}
            {d.isLead && <button className="btn ghost" onClick={() => setShowArchive(true)}>Arsip</button>}
          </div>
          {active && (
            <div className="chips">
              {f.quick === "soon" && <span className="chip">Segera<button aria-label="Hapus filter Segera" onClick={() => set("quick", null)}>✕</button></span>}
              {f.quick === "done_today" && <span className="chip">Selesai hari ini<button aria-label="Hapus filter" onClick={() => set("quick", null)}>✕</button></span>}
              {f.pic !== "all" && <span className="chip">PIC: {f.pic}<button aria-label="Hapus filter PIC" onClick={() => set("pic", "all")}>✕</button></span>}
              <button className="btn sm ghost" onClick={reset}>Hapus semua filter</button>
            </div>
          )}

          {!d.loaded && !d.loadError ? (
            <div className="tasks"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
          ) : groups.length === 0 ? (
            active || f.tab !== "all" ? (
              <Empty title="Tidak ada jobdesk yang cocok" body="Ubah atau hapus filter untuk melihat jobdesk lain." action={<button className="btn" onClick={() => { reset(); set("tab", "all"); }}>Tampilkan semua</button>} />
            ) : (
              <Empty title="Belum ada jobdesk" body={d.canManage ? "Tambahkan jobdesk pertama dan pilih PIC serta deadline-nya." : "CS Lead belum menambahkan jobdesk."}
                action={d.canManage ? <button className="btn primary" onClick={() => setDrawer({ task: null })}>+ Tambah jobdesk</button> : undefined} />
            )
          ) : (
            groups.map((g) => {
              // Jobdesk selesai disembunyikan agar daftar fokus ke yang belum beres. Tab Selesai selalu menampilkannya.
              const forced = f.tab === "done" || f.quick === "done_today";
              const hidden = g.key === "done" && !forced && !showDone;
              return (
              <section className="group" key={g.key} aria-label={g.label}>
                <h2 className={`group-head ${g.key}`}>
                  {g.label}<span className="count">{g.tasks.length}</span>
                  {g.key === "done" && !forced && (
                    <button className="btn sm ghost" onClick={toggleDone} aria-expanded={!hidden}>{hidden ? "Tampilkan" : "Sembunyikan"}</button>
                  )}
                </h2>
                {!hidden && <ul className="tasks" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {g.tasks.map((t) => <TaskRow key={t.id} t={t} now={listNow} onOpen={(x) => setDrawer({ task: x })} onStatus={changeStatus} onArchive={archive} onLate={setLateFor} />)}
                </ul>}
              </section>
              );
            })
          )}
        </main>
        <aside className="side">
          <TeamPanel now={listNow} activePic={f.pic} onPic={(n) => set("pic", n)} />
          <ActivityPanel now={listNow} />
        </aside>
      </div>

      {drawer && <TaskDrawer key={drawer.task?.id ?? "new"} task={drawer.task} onClose={() => setDrawer(null)} />}
      {lateFor && <LateReasonDialog task={lateFor} onClose={() => setLateFor(null)} />}
      {showArchive && <ArchiveDialog onClose={() => setShowArchive(false)} />}
    </>
  );
}
