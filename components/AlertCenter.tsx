"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "./DataProvider";
import { Modal } from "./ui";
import { alertTasks, dueMs, isAbsentToday } from "@/lib/tasks";
import { beep } from "@/lib/beep";
import { showDesktopNotice } from "@/lib/desktop-notify";
import { mmss, relText } from "@/lib/tz";
import type { Task } from "@/lib/types";

const SNOOZE_MS = 15 * 60000;
const REPEAT_BEEP_MS = 3 * 60000;
const KEY = "jobdesk.snooze";
const SOUND_KEY = "jobdesk.sound";

function loadSnooze(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>; } catch { return {}; }
}

/**
 * Pengingat yang sulit diabaikan: jendela peringatan di tengah layar (bukan banner kecil), bunyi yang
 * berulang tiap 3 menit selama belum ditangani, dan judul tab yang berkedip. Pilihannya hanya tiga:
 * sudah selesai, masih dikerjakan, atau tunda 15 menit (lalu muncul lagi).
 */
export default function AlertCenter({ now, onDone, onProgress }: { now: number; onDone: (t: Task) => void; onProgress: (t: Task) => void }) {
  const d = useData();
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  const [sound, setSound] = useState(true);
  const list = useMemo(() => alertTasks(d.tasks, now, snoozed), [d.tasks, now, snoozed]);
  const first = list[0];
  const lastBeep = useRef(0);
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    setSnoozed(loadSnooze());
    try { setSound(localStorage.getItem(SOUND_KEY) !== "0"); } catch { /* abaikan */ }
  }, []);

  // Bunyi saat peringatan baru muncul (atau tunda berakhir), lalu berulang selama belum ditangani.
  const firstId = first?.id ?? null;
  useEffect(() => {
    if (!firstId) { lastId.current = null; return; }
    const t = Date.now();
    if (sound && (lastId.current !== firstId || t - lastBeep.current >= REPEAT_BEEP_MS)) {
      beep();
      // Pojok layar sistem: tetap terlihat saat pengguna di tab atau aplikasi lain.
      if (first) {
        const late = dueMs(first) < t;
        void showDesktopNotice(first.id, late ? `Terlambat: ${first.title}` : `Segera: ${first.title}`,
          `PIC ${first.pic}. ${late ? "Sudah lewat deadline." : "Deadline sebentar lagi."} Buka Jobdesk CS untuk menandai selesai atau menunda.`);
      }
      lastBeep.current = t;
    }
    lastId.current = firstId;
  }, [firstId, sound, Math.floor(now / 30000)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Judul tab berkedip agar terlihat dari tab lain.
  const count = list.length;
  useEffect(() => {
    if (!count) return;
    const base = document.title.replace(/^(\(\d+\) )?(⚠ )?/, "");
    let on = false;
    const id = setInterval(() => {
      on = !on;
      document.title = on ? `⚠ (${count}) Jobdesk perlu dikerjakan` : base;
    }, 1000);
    return () => { clearInterval(id); document.title = base; };
  }, [count]);

  function snooze(t: Task, ms = SNOOZE_MS) {
    const next = { ...loadSnooze(), [t.id]: Date.now() + ms };
    for (const k of Object.keys(next)) if (next[k] < Date.now()) delete next[k];
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* abaikan */ }
    setSnoozed(next);
  }
  function toggleSound(v: boolean) {
    setSound(v);
    try { localStorage.setItem(SOUND_KEY, v ? "1" : "0"); } catch { /* abaikan */ }
  }

  if (!first) return null;
  const diff = dueMs(first) - now;
  const late = diff < 0;
  const absent = isAbsentToday(d.members, first.pic, now);

  return (
    <Modal title={late ? "Deadline terlewat" : "Deadline sebentar lagi"} variant="dialog" onClose={() => snooze(first, 5 * 60000)}
      footer={
        <>
          <label className="check" style={{ marginRight: "auto", color: "var(--muted)", fontSize: 13 }}>
            <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} />Bunyi
          </label>
          <button className="btn" onClick={() => snooze(first)}>Tunda 15 menit</button>
          {first.status !== "in_progress" && <button className="btn" onClick={() => { onProgress(first); snooze(first); }}>Sedang dikerjakan</button>}
          <button className="btn primary" onClick={() => onDone(first)} data-autofocus>Sudah selesai</button>
        </>
      }>
      <div className={`big-alert${late ? " late" : ""}`}>
        <p className="big-time">{late ? relText(diff) : `${mmss(diff)} lagi`}</p>
        <p className="big-title">{first.title}</p>
        <p className="big-pic">PIC: <b>{first.pic}</b>{absent ? " (hari ini tidak masuk)" : ""}</p>
        <p className="hint" style={{ marginTop: 10 }}>
          {late ? "Sudah dikerjakan tapi belum dicentang? Tekan Sudah selesai." : "Kalau sedang mengerjakan hal lain, tunda 15 menit. Pengingat muncul lagi."}
        </p>
        {list.length > 1 && <p className="hint" style={{ marginTop: 6, color: "var(--orange)" }}>+{list.length - 1} jobdesk lain juga perlu perhatian</p>}
      </div>
    </Modal>
  );
}
