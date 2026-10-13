"use client";

import type { Member, Task } from "@/lib/types";
import { dayKey, dueMs, fmtTime, isAbsent, mmss, relText } from "@/lib/time";
import PicSelect from "./PicSelect";

interface Props {
  alerts: Task[];
  members: Member[];
  now: number;
  canWrite: boolean;
  onDone: (t: Task) => void;
  onSnooze: (t: Task) => void;
  onReassign: (t: Task, pic: string) => void;
}

export default function AlertBar({ alerts, members, now, canWrite, onDone, onSnooze, onReassign }: Props) {
  const today = dayKey(now);
  const shown = alerts.slice(0, 4);
  return (
    <div className="alerts" aria-live="assertive">
      {shown.map((t) => {
        const due = dueMs(t);
        const late = due < now;
        const absent = isAbsent(members, t.pic, today);
        return (
          <div key={t.id} className={"alert " + (late ? "late" : "soon")} role="alert">
            <div className="alert-body">
              <div className="alert-title">Belum selesai: {t.title}</div>
              <div className="alert-meta">
                PIC <b>{t.pic}</b> &middot; tenggat {fmtTime(due)} &middot;{" "}
                <span className="mono">{late ? relText(due - now) : "sisa " + mmss(due - now)}</span>
              </div>
              {absent && (
                <div className="alert-meta">PIC hari ini tidak masuk. Alihkan ke anggota lain.</div>
              )}
            </div>
            <div className="alert-actions">
              {absent && (
                <PicSelect
                  current={t.pic}
                  members={members}
                  today={today}
                  inAlert
                  disabled={!canWrite}
                  onPick={(p) => onReassign(t, p)}
                />
              )}
              <button type="button" className="btn solid" disabled={!canWrite} onClick={() => onDone(t)}>
                Tandai selesai
              </button>
              <button type="button" className="btn" onClick={() => onSnooze(t)}>
                Sembunyikan 2 mnt
              </button>
            </div>
          </div>
        );
      })}
      {alerts.length > shown.length && (
        <div className="alert-more">
          +{alerts.length - shown.length} jobdesk lain juga perlu perhatian, lihat daftar di bawah.
        </div>
      )}
    </div>
  );
}
