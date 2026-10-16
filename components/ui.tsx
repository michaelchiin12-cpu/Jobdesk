"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Priority, Status } from "@/lib/types";
import { PRIORITY_LABEL, STATUS_LABEL } from "@/lib/types";
import type { Urgency } from "@/lib/tasks";
import { relText } from "@/lib/tz";

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`badge pr-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

export function DeadlineBadge({ urgency, diff }: { urgency: Urgency; diff: number }) {
  if (urgency === "done") return null;
  if (urgency === "later") return null;
  return <span className={`badge dl-${urgency}`}>{relText(diff)}</span>;
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${h} 38% 26%)`, color: `hsl(${h} 70% 82%)`, fontSize: size * 0.4 }} aria-hidden>
      {initials || "?"}
    </span>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Laci samping atau dialog tengah: menutup dengan Esc atau klik latar, fokus terjebak di dalam. */
export function Modal({
  title, onClose, children, variant = "dialog", footer,
}: { title: string; onClose: () => void; children: ReactNode; variant?: "dialog" | "drawer"; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose sering berupa fungsi baru di tiap render (dasbor menggambar ulang tiap detik). Simpan di ref agar
  // efek di bawah hanya jalan sekali; kalau tidak, fokus dikembalikan tiap detik dan dropdown PIC menutup sendiri.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, []);
  return (
    <div className={`scrim ${variant}`} onMouseDown={(e) => e.target === e.currentTarget && closeRef.current()}>
      <div className={`modal ${variant}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup">✕</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className={`field${error ? " has-error" : ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <p className="hint">{hint}</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {body && <p className="empty-body">{body}</p>}
      {action}
    </div>
  );
}
