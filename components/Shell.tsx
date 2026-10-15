"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import DataProvider, { useData } from "./DataProvider";
import ToastProvider from "./Toast";
import Login from "./Login";
import NotificationCenter from "./NotificationCenter";
import SettingsDialog from "./SettingsDialog";
import { Avatar } from "./ui";
import { useNow } from "@/lib/now";
import { fmtDateLong, fmtTime, parts, pad } from "@/lib/tz";
import { memberNames } from "@/lib/tasks";
import { visibleNotifs } from "@/lib/notif-view";

function Clock() {
  const now = useNow(1000);
  if (!now) return <small>&nbsp;</small>;
  const p = parts(now);
  return <small suppressHydrationWarning>{fmtDateLong(now)}, {fmtTime(now)}:{pad(Math.floor((now / 1000) % 60))} WIB</small>;
}

const CONN_LABEL = { connecting: "Menyambung...", live: "Terhubung realtime", polling: "Realtime terputus, memperbarui tiap 30 dtk", offline: "Offline" } as const;

function Header() {
  const d = useData();
  const path = usePathname();
  const [openBell, setOpenBell] = useState(false);
  const [openSet, setOpenSet] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(0);

  useEffect(() => {
    try { setSeen(Number(localStorage.getItem("jobdesk.seenNotif") ?? 0)); } catch { /* abaikan */ }
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menu]);

  const mine = visibleNotifs(d.notifications, d.isLead, d.me);
  const unread = mine.filter((n) => n.id > seen).length;
  const markSeen = () => {
    const top = mine.reduce((m, n) => Math.max(m, n.id), seen);
    setSeen(top);
    try { localStorage.setItem("jobdesk.seenNotif", String(top)); } catch { /* abaikan */ }
  };
  const names = memberNames(d.members);

  const link = (href: string, label: string) => (
    <Link href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>
  );

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <Image src="/logo.png" alt="" width={34} height={34} />
          <div><b>Jobdesk CS</b><Clock /></div>
        </div>
        <nav className="navlinks" aria-label="Halaman">
          {link("/", "Dasbor")}
          {d.canManage && link("/template", "Template")}
          {link("/laporan", "Laporan")}
        </nav>
        <div className="top-right">
          <span className={`conn ${d.conn}`} role="status" title={CONN_LABEL[d.conn]}>
            <i className="dot" /><span>{CONN_LABEL[d.conn]}</span>
          </span>
          <button className="icon-btn" aria-label={`Notifikasi${unread ? `, ${unread} baru` : ""}`} onClick={() => { setOpenBell(true); markSeen(); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
            {unread > 0 && <span className="bell-count">{unread > 9 ? "9+" : unread}</span>}
          </button>
          <button className="icon-btn" aria-label="Pengaturan" onClick={() => setOpenSet(true)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
          <div className="profile" ref={menuRef}>
            <button className="profile-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Avatar name={d.actor} size={28} />
              <span className="who">{d.actor}<small>{d.isLead ? "CS Lead" : "Tim CS"}</small></span>
            </button>
            {menu && (
              <div className="menu" role="menu">
                <p className="menu-label">Saya adalah</p>
                <button role="menuitem" onClick={() => { d.setMe(null); setMenu(false); }}>{d.me === null ? "✓ " : ""}Tidak memilih ({d.isLead ? "CS Lead" : "Tim CS"})</button>
                {names.map((n) => (
                  <button key={n} role="menuitem" onClick={() => { d.setMe(n); setMenu(false); }}>{d.me === n ? "✓ " : ""}{n}</button>
                ))}
                <hr />
                <button role="menuitem" onClick={() => { setMenu(false); void d.signOut(); }}>Keluar</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {openBell && <NotificationCenter onClose={() => setOpenBell(false)} />}
      {openSet && <SettingsDialog onClose={() => setOpenSet(false)} />}
    </>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const d = useData();
  if (!d.ready) return <main className="login"><p className="sub" style={{ color: "var(--muted)" }}>Memuat...</p></main>;
  if (!d.session) return <Login />;
  if (d.roleError) {
    return (
      <main className="login">
        <div className="login-card">
          <h1>Akses belum aktif</h1>
          <p className="sub">{d.roleError}</p>
          <button className="btn block" onClick={() => void d.signOut()}>Keluar</button>
        </div>
      </main>
    );
  }
  if (!d.role) return <main className="login"><p style={{ color: "var(--muted)" }}>Memeriksa akses...</p></main>;
  return (
    <div className="shell">
      <Header />
      {children}
    </div>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <DataProvider>
        <Gate>{children}</Gate>
      </DataProvider>
    </ToastProvider>
  );
}
