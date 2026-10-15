"use client";

import { useData } from "./DataProvider";
import { describeEvent } from "@/lib/describe";
import { relPast } from "@/lib/tz";

export default function ActivityPanel({ now }: { now: number }) {
  const d = useData();
  return (
    <section className="panel" aria-label="Aktivitas terbaru">
      <div className="panel-head"><h2>Aktivitas terbaru</h2></div>
      {d.events.length === 0 ? (
        <p className="hint" style={{ color: "var(--faint)" }}>Belum ada aktivitas. Perubahan jobdesk akan tercatat di sini.</p>
      ) : (
        <div className="timeline">
          {d.events.slice(0, 30).map((e) => {
            const x = describeEvent(e, now);
            return (
              <div className="tl-item" key={e.id}>
                <i className={`tl-dot ${x.tone}`} />
                <div>
                  <p className="tl-text">{x.text}</p>
                  <p className="tl-time">{relPast(Date.parse(e.created_at), now)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
