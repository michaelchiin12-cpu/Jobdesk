"use client";

import { useEffect, useState } from "react";
import { Modal } from "./ui";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import * as api from "@/lib/api";
import {
  ALL_KINDS, currentSubscription, disablePush, enablePush, loadPrefs, permissionState, pushSupported,
  sendTestPush, updatePushPrefs,
} from "@/lib/notifications";
import { memberNames } from "@/lib/tasks";
import type { AppSettings, NotifKind, SchedulerStatus } from "@/lib/types";
import { NOTIF_KIND_LABEL } from "@/lib/types";
import { relPast } from "@/lib/tz";

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const d = useData();
  const toast = useToast();
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [kinds, setKinds] = useState<NotifKind[]>(ALL_KINDS);
  const [member, setMember] = useState<string>(d.me ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const supported = pushSupported();
  const perm = permissionState();

  useEffect(() => {
    let off = false;
    (async () => {
      const sub = await currentSubscription();
      if (off) return;
      setSubscribed(!!sub);
      if (sub) {
        const p = await loadPrefs();
        if (!off && p) {
          setKinds(p.kinds);
          setMember(p.member ?? "");
        }
      }
    })();
    if (d.isLead) api.schedulerStatus().then((r) => !off && r.ok && setSched(r.data));
    return () => { off = true; };
  }, [d.isLead]);

  const say = (text: string, ok = false) => setMsg({ text, ok });

  async function enable() {
    setBusy(true); setMsg(null);
    const r = await enablePush(member || null, kinds);
    setBusy(false);
    if (r.ok) { setSubscribed(true); say("Notifikasi aktif di perangkat ini. Kirim notifikasi uji untuk memastikan.", true); }
    else say(r.error);
  }
  async function disable() {
    setBusy(true);
    const r = await disablePush();
    setBusy(false);
    if (r.ok) { setSubscribed(false); say("Notifikasi dimatikan di perangkat ini.", true); } else say(r.error ?? "Gagal mematikan notifikasi.");
  }
  async function test() {
    setBusy(true); setMsg(null);
    const r = await sendTestPush();
    setBusy(false);
    if (r.ok) say(`Layanan push menerima notifikasi uji (kode ${r.status}). Jika tidak muncul, periksa pengaturan notifikasi di sistem operasi.`, true);
    else say(r.error);
  }
  async function toggleKind(k: NotifKind) {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    setKinds(next);
    if (subscribed) {
      const r = await updatePushPrefs(member || null, next);
      if (!r.ok) say(r.error);
    }
  }
  async function changeMember(name: string) {
    setMember(name);
    if (subscribed) {
      const r = await updatePushPrefs(name || null, kinds);
      if (!r.ok) say(r.error);
    }
  }
  async function setting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    const before = d.settings[key];
    d.mergeSettings({ [key]: value } as Partial<AppSettings>);
    const r = await api.saveSetting(key, value);
    if (!r.ok) {
      d.mergeSettings({ [key]: before } as Partial<AppSettings>);
      toast(r.error, true);
    }
  }

  return (
    <Modal title="Pengaturan" onClose={onClose} variant="drawer">
      <section>
        <h3 style={{ marginBottom: 6 }}>Notifikasi di perangkat ini</h3>
        {!supported && (
          <p className="warn-box">Browser ini belum bisa menerima notifikasi push, atau kunci push belum dipasang di server. Pengingat tetap tampil sebagai banner saat dasbor terbuka.</p>
        )}
        {supported && perm === "denied" && (
          <p className="warn-box">Izin notifikasi diblokir di browser. Buka pengaturan situs, ubah Notifikasi menjadi Izinkan, lalu muat ulang.</p>
        )}
        <div className="field">
          <label htmlFor="mem">Perangkat ini dipakai oleh</label>
          <select id="mem" value={member} onChange={(e) => void changeMember(e.target.value)}>
            <option value="">Tidak memilih (hanya pengingat umum)</option>
            {memberNames(d.members).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <p className="hint">Dipakai agar jobdesk milik Anda dikirim ke perangkat ini.</p>
        </div>
        <div className="field">
          <label>Jenis notifikasi</label>
          {ALL_KINDS.filter((k) => k !== "lead_overdue" || d.isLead).map((k) => (
            <label key={k} className="check"><input type="checkbox" checked={kinds.includes(k)} onChange={() => void toggleKind(k)} />{NOTIF_KIND_LABEL[k]}</label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {subscribed ? (
            <>
              <button className="btn" onClick={test} disabled={busy}>Kirim notifikasi uji</button>
              <button className="btn ghost" onClick={disable} disabled={busy}>Matikan</button>
            </>
          ) : (
            <button className="btn primary" onClick={enable} disabled={busy || !supported || subscribed === null}>Aktifkan notifikasi</button>
          )}
        </div>
        {msg && <p className={`msg${msg.ok ? " ok" : ""}`} role="status">{msg.text}</p>}
      </section>

      {d.isLead && (
        <section style={{ marginTop: 26 }}>
          <h3 style={{ marginBottom: 8 }}>Pengaturan tim (CS Lead)</h3>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={d.settings.cs_can_manage} onChange={(e) => void setting("cs_can_manage", e.target.checked)} />
            Tim CS boleh membuat dan mengubah jobdesk
          </label>
          <label className="check" style={{ marginBottom: 10 }}>
            <input type="checkbox" checked={d.settings.lead_escalation} onChange={(e) => void setting("lead_escalation", e.target.checked)} />
            Beri tahu CS Lead bila jobdesk High terlambat
          </label>
          {d.settings.lead_escalation && (
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="esc">Terlambat lebih dari (menit)</label>
              <input id="esc" type="number" min={1} max={240} value={d.settings.escalation_minutes}
                onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 240) void setting("escalation_minutes", v); }} />
            </div>
          )}
          <label className="check" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={d.settings.digests_enabled} onChange={(e) => void setting("digests_enabled", e.target.checked)} />
            Kirim ringkasan pagi ({d.settings.digest_morning}) dan sore ({d.settings.digest_evening}) WIB
          </label>
          <h3 style={{ margin: "12px 0 6px" }}>Status pengirim otomatis</h3>
          {sched ? (
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)" }}>
              <li>Penjadwal: {sched.cron_job ? "aktif" : "belum aktif di database"}</li>
              <li>Terakhir berjalan: {sched.last_run ? relPast(Date.parse(sched.last_run), Date.now()) : "belum pernah"}</li>
              <li>Pengiriman push: {sched.push_configured ? "sudah dikonfigurasi" : "belum dikonfigurasi (notifikasi hanya tampil di dasbor)"}</li>
            </ul>
          ) : <p className="hint">Memuat status...</p>}
        </section>
      )}
    </Modal>
  );
}
