"use client";

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import * as api from "@/lib/api";
import type { Result } from "@/lib/api";
import { getSupabase, isConfigured } from "@/lib/supabase";
import type {
  AppNotification, AppSettings, Member, Role, Task, TaskEvent, Template,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/types";

export type Conn = "connecting" | "live" | "polling" | "offline";

interface Ctx {
  ready: boolean;
  configured: boolean;
  session: Session | null;
  role: Role | null;
  roleError: string | null;
  /** Nama yang tercatat di riwayat: nama anggota yang dipilih di perangkat ini, atau nama peran. */
  actor: string;
  me: string | null;
  setMe: (name: string | null) => void;
  canManage: boolean;
  isLead: boolean;
  conn: Conn;
  loadError: string | null;
  loaded: boolean;
  lastSync: number | null;
  tasks: Task[];
  members: Member[];
  templates: Template[];
  events: TaskEvent[];
  notifications: AppNotification[];
  settings: AppSettings;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  // perubahan: hasilnya langsung digabung ke state lokal
  createTask: (t: api.NewTask) => Promise<Result<Task>>;
  editTask: (id: string, patch: api.TaskPatch) => Promise<Result<Task>>;
  lateReason: (id: string, reason: Parameters<typeof api.setLateReason>[1], note: string) => Promise<Result<Task>>;
  mergeSettings: (s: Partial<AppSettings>) => void;
}

const DataCtx = createContext<Ctx | null>(null);

export function useData(): Ctx {
  const c = useContext(DataCtx);
  if (!c) throw new Error("useData dipakai di luar DataProvider");
  return c;
}

const ME_KEY = "jobdesk.me";
const POLL_MS = 30000;

function upsertById<T extends { id: string | number }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  if (i === -1) return [row, ...list];
  const copy = list.slice();
  copy[i] = row;
  return copy;
}

export default function DataProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [me, setMeState] = useState<string | null>(null);
  const [conn, setConn] = useState<Conn>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const seq = useRef(0);

  /* ---------- sesi dan peran ---------- */
  useEffect(() => {
    try {
      setMeState(localStorage.getItem(ME_KEY));
    } catch { /* penyimpanan diblokir */ }
    const sb = getSupabase();
    if (!sb) {
      setReady(true);
      return;
    }
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      setRole(null);
      setRoleError(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    api.myRole().then((r) => {
      if (cancelled) return;
      if (!r.ok) setRoleError(r.error);
      else if (!r.data) setRoleError("Akun ini belum punya peran di Jobdesk CS. Hubungi CS Lead.");
      else {
        setRole(r.data);
        setRoleError(null);
      }
    });
    return () => { cancelled = true; };
  }, [userId]);

  const setMe = useCallback((name: string | null) => {
    setMeState(name);
    try {
      if (name) localStorage.setItem(ME_KEY, name);
      else localStorage.removeItem(ME_KEY);
    } catch { /* abaikan */ }
  }, []);

  /* ---------- muat data ---------- */
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    const [t, m, tp, ev, nf, st] = await Promise.all([
      api.fetchTasks(), api.fetchMembers(), api.fetchTemplates(), api.fetchEvents(60),
      api.fetchNotifications(60), api.fetchSettings(),
    ]);
    if (id !== seq.current) return; // ada pemuatan yang lebih baru
    const firstError = [t, m, tp, ev, nf, st].find((r) => !r.ok);
    if (firstError && !firstError.ok) {
      setLoadError(firstError.error);
      setConn((c) => (c === "live" ? c : "offline"));
      return;
    }
    if (t.ok) setTasks(t.data);
    if (m.ok) setMembers(m.data);
    if (tp.ok) setTemplates(tp.data);
    if (ev.ok) setEvents(ev.data);
    if (nf.ok) setNotifications(nf.data);
    if (st.ok) setSettings(st.data);
    setLoadError(null);
    setLoaded(true);
    setLastSync(Date.now());
  }, []);

  useEffect(() => {
    if (!role) return;
    const sb = getSupabase();
    if (!sb) return;
    let stopped = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => !stopped && refresh(), 400);
    };
    void refresh();

    const channel = sb
      .channel("jobdesk-v2")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (p) => {
        if (p.eventType === "DELETE") {
          const old = p.old as { id?: string };
          if (old.id) setTasks((l) => l.filter((x) => x.id !== old.id));
          return;
        }
        const row = p.new as Task;
        if (row.archived_at) setTasks((l) => l.filter((x) => x.id !== row.id));
        else setTasks((l) => upsertById(l, row));
        soon(); // riwayat dan notifikasi ikut berubah karena pemicu database
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "team_members" }, soon)
      .on("postgres_changes", { event: "*", schema: "public", table: "task_templates" }, soon)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (p) => {
        setNotifications((l) => upsertById(l, p.new as AppNotification).slice(0, 60));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "notifications" }, (p) => {
        setNotifications((l) => upsertById(l, p.new as AppNotification));
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "task_events" }, (p) => {
        setEvents((l) => upsertById(l, p.new as TaskEvent).slice(0, 60));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, soon)
      .subscribe((status) => {
        if (stopped) return;
        if (status === "SUBSCRIBED") {
          setConn("live");
          void refresh(); // kejar perubahan yang terlewat saat terputus
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConn((c) => (navigator.onLine ? "polling" : "offline"));
        }
      });

    // Cadangan bila websocket tertahan: ambil ulang berkala dan saat tab kembali aktif.
    const poll = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    const onOnline = () => { setConn("polling"); void refresh(); };
    const onOffline = () => setConn("offline");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      sb.removeChannel(channel);
    };
  }, [role, refresh]);

  /* ---------- tindakan ---------- */
  const actor = me ?? (role === "lead" ? "CS Lead" : "Tim CS");

  const createTask = useCallback(async (t: api.NewTask) => {
    const r = await api.insertTask(t, actor);
    if (r.ok) setTasks((l) => upsertById(l, r.data));
    return r;
  }, [actor]);

  const editTask = useCallback(async (id: string, patch: api.TaskPatch) => {
    const r = await api.updateTask(id, patch, actor);
    if (r.ok) setTasks((l) => (r.data.archived_at ? l.filter((x) => x.id !== id) : upsertById(l, r.data)));
    return r;
  }, [actor]);

  const lateReason = useCallback(async (id: string, reason: Parameters<typeof api.setLateReason>[1], note: string) => {
    const r = await api.setLateReason(id, reason, note, actor);
    if (r.ok) setTasks((l) => upsertById(l, r.data));
    return r;
  }, [actor]);

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    setTasks([]); setMembers([]); setTemplates([]); setEvents([]); setNotifications([]);
    setLoaded(false);
  }, []);

  const mergeSettings = useCallback((s: Partial<AppSettings>) => setSettings((x) => ({ ...x, ...s })), []);

  const value = useMemo<Ctx>(() => ({
    ready, configured: isConfigured, session, role, roleError, actor, me, setMe,
    isLead: role === "lead",
    canManage: role === "lead" || (role === "cs" && settings.cs_can_manage),
    conn, loadError, loaded, lastSync, tasks, members, templates, events, notifications, settings,
    refresh, signOut, createTask, editTask, lateReason, mergeSettings,
  }), [ready, session, role, roleError, actor, me, setMe, conn, loadError, loaded, lastSync, tasks, members,
    templates, events, notifications, settings, refresh, signOut, createTask, editTask, lateReason, mergeSettings]);

  return <DataCtx.Provider value={value}>{children}</DataCtx.Provider>;
}
