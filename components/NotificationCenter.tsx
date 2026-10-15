"use client";

import { Empty, Modal } from "./ui";
import { useData } from "./DataProvider";
import { useNow } from "@/lib/now";
import { relPast } from "@/lib/tz";
import { visibleNotifs } from "@/lib/notif-view";
import { PUSH_STATE_LABEL } from "@/lib/types";

export default function NotificationCenter({ onClose }: { onClose: () => void }) {
  const d = useData();
  const now = useNow(30000) || Date.now();
  const list = visibleNotifs(d.notifications, d.isLead, d.me);
  return (
    <Modal title="Notifikasi" onClose={onClose} variant="drawer">
      {list.length === 0 ? (
        <Empty title="Belum ada notifikasi" body="Pengingat deadline, jobdesk baru, dan ringkasan harian akan muncul di sini." />
      ) : (
        list.map((n) => (
          <div key={n.id} className={`notif${n.urgent ? " urgent" : ""}`}>
            <b>{n.title}</b>
            <p>{n.body}</p>
            <small>
              {relPast(Date.parse(n.created_at), now)} · Push: {PUSH_STATE_LABEL[n.push_state]}
              {n.push_state === "partial" ? ` (${n.push_sent} diterima, ${n.push_failed} gagal)` : ""}
            </small>
          </div>
        ))
      )}
    </Modal>
  );
}
