"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Member, NewTask, Task } from "@/lib/types";
import { KEEP_DONE_MS, SNOOZE_MS, SOON_MS, dayKey, dueMs, nextDue, todayLong } from "@/lib/time";
import LoginGate from "./LoginGate";
import AlertBar from "./AlertBar";
import AddForm from "./AddForm";
import TeamPanel from "./TeamPanel";
import TaskList from "./TaskList";

type Live = "connecting" | "ok" | "err";
type Auth = "loading" | "in" | "out";
type NotifState = NotificationPermission | "unsupported";

interface Change {
  eventType: string;
  new: unknown;
  old: unknown;
}

function applyChange<T extends { id: string }>(prev: T[], p: Change): T[] {
  if (p.eventType === "DELETE") {
    const id = (p.old as { id?: string } | null)?.id;
    return id ? prev.filter((x) => x.id !== id) : prev;
  }
  const row = p.new as T;
  const i = prev.findIndex((x) => x.id === row.id);
  if (i < 0) return [...prev, row];
  const copy = prev.slice();
  copy[i] = row;
  return copy;
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export default function JobdeskApp() {
  const [auth, setAuth] = useState<Auth>("loading");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState<Live>("connecting");
  const [snoozed, setSnoozed] = useState<Record<string, number>>({});
  const [sound, setSound] = useState(false);
  const [notif, setNotif] = useState<NotifState>("unsupported");
  const [toastMsg, setToastMsg] = useState("");

  const now = useNow(1000);
  const soundRef = useRef(false);
  const actxRef = useRef<AudioContext | null>(null);
  const lastBeep = useRef(0);
  const notified = useRef<Set<string>>(new Set());
  const alertsRef = useRef<Task[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pruned = useRef(false);

  /* ---------- masuk / keluar ---------- */
  useEffect(() => {
    const sb = getSupabase();
    if (!sb) {
      setAuth("out");
      return;
    }
    let active = true;
    sb.auth.getSession().then(({ data }) => {
      if (active) setAuth(data.session ? "in" : "out");
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setAuth(session ? "in" : "out");
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  /* ---------- data realtime ---------- */
  useEffect(() => {
    if (auth !== "in") return;
    const sb = getSupabase();
    if (!sb) return;
    let alive = true;

    const load = async () => {
      const [t, m] = await Promise.all([
        sb.from("tasks").select("*").order("due_at", { ascending: false }).limit(500),
        sb.from("team_members").select("*").order("created_at", { ascending: true }),
      ]);
      if (!alive) return;
      if (t.error || m.error) {
        setLive("err");
        return;
      }
      setTasks(t.data as Task[]);
      setMembers(m.data as Member[]);
      setLoaded(true);
    };
    load();

    const channel = sb
      .channel("jobdesk")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (p) => {
        if (alive) setTasks((prev) => applyChange<Task>(prev, p));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "team_members" }, (p) => {
        if (alive) setMembers((prev) => applyChange<Member>(prev, p));
      })
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") {
          setLive("ok");
          load();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setLive("err");
        }
      });

    const poll = setInterval(load, 30000);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      sb.removeChannel(channel);
    };
  }, [auth]);

  /* Bersihkan jobdesk selesai yang sudah lebih dari 14 hari, sekali per kunjungan. */
  useEffect(() => {
    if (!loaded || pruned.current) return;
    pruned.current = true;
    const sb = getSupabase();
    if (!sb) return;
    const cutoff = new Date(Date.now() - KEEP_DONE_MS).toISOString();
    sb.from("tasks").delete().eq("done", true).lt("done_at", cutoff).then(() => undefined);
  }, [loaded]);

  /* ---------- suara dan notifikasi browser ---------- */
  const ensureAudio = useCallback(() => {
    if (!actxRef.current) {
      try {
        const C =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (C) actxRef.current = new C();
      } catch {
        actxRef.current = null;
      }
    }
    const a = actxRef.current;
    if (a && a.state === "suspended") a.resume().catch(() => undefined);
  }, []);

  const beep = useCallback(() => {
    const a = actxRef.current;
    if (!soundRef.current || !a) return;
    lastBeep.current = Date.now();
    try {
      const t0 = a.currentTime;
      [880, 660, 880].forEach((f, i) => {
        const o = a.createOscillator();
        const g = a.createGain();
        const s = t0 + i * 0.24;
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.3, s + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 0.2);
        o.connect(g);
        g.connect(a.destination);
        o.start(s);
        o.stop(s + 0.22);
      });
    } catch {
      /* suara gagal diputar, abaikan */
    }
  }, []);

  useEffect(() => {
    try {
      const on = localStorage.getItem("jobdesk-sound") === "1";
      setSound(on);
      soundRef.current = on;
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
    setNotif(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    const onPointer = () => {
      if (soundRef.current) ensureAudio();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [ensureAudio]);

  function toggleSound() {
    const on = !sound;
    setSound(on);
    soundRef.current = on;
    if (on) {
      ensureAudio();
      beep();
    }
    try {
      localStorage.setItem("jobdesk-sound", on ? "1" : "0");
    } catch {
      /* abaikan */
    }
  }

  async function enableNotif() {
    if (typeof Notification === "undefined") return;
    try {
      setNotif(await Notification.requestPermission());
    } catch {
      /* abaikan */
    }
  }

  /* ---------- peringatan ---------- */
  const alerts = tasks
    .filter((t) => !t.done && dueMs(t) - now <= SOON_MS && !((snoozed[t.id] || 0) > now))
    .sort((a, b) => dueMs(a) - dueMs(b));
  alertsRef.current = alerts;
  const sig = alerts.map((t) => t.id + (dueMs(t) < now ? "l" : "s")).join(",");

  useEffect(() => {
    const cur = new Set(sig ? sig.split(",") : []);
    let fresh = false;
    cur.forEach((k) => {
      if (!notified.current.has(k)) fresh = true;
    });
    notified.current = cur;
    if (!fresh) return;
    beep();
    const first = alertsRef.current[0];
    if (first && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      try {
        new Notification("Jobdesk belum selesai", { body: first.title + " - PIC " + first.pic });
      } catch {
        /* abaikan */
      }
    }
  }, [sig, beep]);

  useEffect(() => {
    if (alerts.length && sound && now - lastBeep.current > 60000) beep();
  }, [now, alerts.length, sound, beep]);

  useEffect(() => {
    try {
      document.title = alerts.length
        ? Math.floor(now / 1000) % 2
          ? "(" + alerts.length + ") Perlu perhatian"
          : "Jobdesk CS"
        : "Jobdesk CS";
    } catch {
      /* abaikan */
    }
  }, [now, alerts.length]);

  /* ---------- aksi ---------- */
  const toast = useCallback((m: string) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), 4500);
  }, []);
  const fail = useCallback(() => toast("Perubahan belum tersimpan. Periksa koneksi lalu coba lagi."), [toast]);
  const upsertTask = (row: Task) => setTasks((p) => applyChange<Task>(p, { eventType: "UPDATE", new: row, old: null }));
  const upsertMember = (row: Member) =>
    setMembers((p) => applyChange<Member>(p, { eventType: "UPDATE", new: row, old: null }));

  async function addTask(input: NewTask): Promise<boolean> {
    const sb = getSupabase();
    if (!sb) return false;
    const { data, error } = await sb
      .from("tasks")
      .insert({ title: input.title, pic: input.pic, due_at: input.due_at, note: input.note, repeat: input.repeat })
      .select()
      .single();
    if (error || !data) {
      fail();
      return false;
    }
    upsertTask(data as Task);
    toast("Jobdesk ditambahkan untuk " + input.pic + ".");
    return true;
  }

  async function setDone(t: Task, done: boolean) {
    const sb = getSupabase();
    if (!sb) return;
    if (!done) {
      const { data, error } = await sb.from("tasks").update({ done: false, done_at: null }).eq("id", t.id).select().single();
      if (error || !data) return fail();
      upsertTask(data as Task);
      return;
    }
    const doneAt = new Date().toISOString();
    if (t.repeat !== "none" && !t.spawned) {
      // Hanya satu PC yang berhasil menandai spawned, sehingga jobdesk berikutnya tidak dobel.
      const res = await sb
        .from("tasks")
        .update({ done: true, done_at: doneAt, spawned: true })
        .eq("id", t.id)
        .eq("spawned", false)
        .select();
      if (res.error) return fail();
      if (res.data && res.data.length) {
        upsertTask(res.data[0] as Task);
        const next = nextDue(dueMs(t), t.repeat, Date.now());
        const ins = await sb
          .from("tasks")
          .insert({ title: t.title, pic: t.pic, due_at: new Date(next).toISOString(), note: t.note ?? "", repeat: t.repeat })
          .select()
          .single();
        if (ins.error || !ins.data) return fail();
        upsertTask(ins.data as Task);
        return;
      }
    }
    const { data, error } = await sb.from("tasks").update({ done: true, done_at: doneAt }).eq("id", t.id).select().single();
    if (error || !data) return fail();
    upsertTask(data as Task);
  }

  async function reassign(t: Task, pic: string) {
    const sb = getSupabase();
    if (!sb || !pic || pic === t.pic) return;
    const { data, error } = await sb.from("tasks").update({ pic }).eq("id", t.id).select().single();
    if (error || !data) return fail();
    upsertTask(data as Task);
  }

  async function deleteTask(t: Task) {
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.from("tasks").delete().eq("id", t.id);
    if (error) return fail();
    setTasks((p) => p.filter((x) => x.id !== t.id));
  }

  async function addMember(name: string): Promise<boolean> {
    const sb = getSupabase();
    if (!sb) return false;
    if (members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      toast("Nama itu sudah ada di tim.");
      return false;
    }
    const { data, error } = await sb.from("team_members").insert({ name }).select().single();
    if (error || !data) {
      toast(error?.code === "23505" ? "Nama itu sudah ada di tim." : "Perubahan belum tersimpan. Periksa koneksi lalu coba lagi.");
      return false;
    }
    upsertMember(data as Member);
    return true;
  }

  async function toggleAbsent(m: Member) {
    const sb = getSupabase();
    if (!sb) return;
    const today = dayKey(Date.now());
    const { data, error } = await sb
      .from("team_members")
      .update({ absent_on: m.absent_on === today ? null : today })
      .eq("id", m.id)
      .select()
      .single();
    if (error || !data) return fail();
    upsertMember(data as Member);
  }

  async function removeMember(m: Member) {
    const sb = getSupabase();
    if (!sb) return;
    const { error } = await sb.from("team_members").delete().eq("id", m.id);
    if (error) return fail();
    setMembers((p) => p.filter((x) => x.id !== m.id));
  }

  async function signOut() {
    const sb = getSupabase();
    if (sb) await sb.auth.signOut();
    setTasks([]);
    setMembers([]);
    setLoaded(false);
    setLive("connecting");
    pruned.current = false;
  }

  /* ---------- tampilan ---------- */
  if (auth === "loading") {
    return (
      <div className="wrap">
        <p className="hint">Memuat...</p>
      </div>
    );
  }
  if (auth === "out") {
    return (
      <div className="wrap">
        <LoginGate />
      </div>
    );
  }

  const today = dayKey(now);
  let late = 0;
  let soon = 0;
  let pending = 0;
  let doneToday = 0;
  tasks.forEach((t) => {
    if (t.done) {
      if (t.done_at && dayKey(Date.parse(t.done_at)) === today) doneToday++;
      return;
    }
    pending++;
    const diff = dueMs(t) - now;
    if (diff < 0) late++;
    else if (diff <= SOON_MS) soon++;
  });

  const liveText = live === "ok" ? "Realtime tersambung" : live === "err" ? "Koneksi terputus" : "Menghubungkan";
  const stat = (cls: string, n: number, label: string) => (
    <div className={"stat " + cls}>
      <b className={"mono" + (n > 0 ? " on" : "")}>{n}</b>
      <span>{label}</span>
    </div>
  );

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Jobdesk CS</h1>
          <p className="sub">{todayLong(now)}</p>
        </div>
        <div className="top-actions">
          <span className={"live" + (live === "ok" ? " ok" : live === "err" ? " err" : "")}>
            <i />
            <span>{liveText}</span>
          </span>
          <button className="btn" type="button" aria-pressed={sound} onClick={toggleSound}>
            Suara notifikasi: {sound ? "nyala" : "mati"}
          </button>
          {notif === "default" && (
            <button className="btn" type="button" onClick={enableNotif}>
              Aktifkan notifikasi layar
            </button>
          )}
          <button className="btn" type="button" onClick={signOut}>
            Keluar
          </button>
        </div>
      </header>

      <AlertBar
        alerts={alerts}
        members={members}
        now={now}
        canWrite
        onDone={(t) => setDone(t, true)}
        onSnooze={(t) => setSnoozed((s) => ({ ...s, [t.id]: Date.now() + SNOOZE_MS }))}
        onReassign={reassign}
      />

      {live === "err" && loaded && (
        <div className="notice">Koneksi ke database terputus. Papan mencoba tersambung lagi otomatis.</div>
      )}

      <section className="stats" aria-label="Ringkasan">
        {stat("late", late, "Terlambat")}
        {stat("soon", soon, "Tenggat 10 menit")}
        {stat("pend", pending, "Belum selesai")}
        {stat("done", doneToday, "Selesai hari ini")}
      </section>

      <div className="layout">
        <aside>
          <AddForm members={members} disabled={false} onAdd={addTask} />
          <TeamPanel
            members={members}
            tasks={tasks}
            loaded={loaded}
            now={now}
            canWrite
            onAdd={addMember}
            onToggleAbsent={toggleAbsent}
            onRemove={removeMember}
          />
        </aside>
        <main>
          <TaskList
            tasks={tasks}
            members={members}
            loaded={loaded}
            now={now}
            canWrite
            onToggle={setDone}
            onReassign={reassign}
            onDelete={deleteTask}
          />
        </main>
      </div>

      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
