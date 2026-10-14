// Notifikasi browser (Web Push). Izin ditolak, browser tidak mendukung, dan kegagalan
// berlangganan semuanya dikembalikan sebagai pesan yang bisa ditampilkan apa adanya.
import { getSubscription, removeSubscription, saveSubscription } from "./api";
import type { NotifKind } from "./types";
import { getSupabase } from "./supabase";

export const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export const ALL_KINDS: NotifKind[] = [
  "reminder", "overdue", "assigned", "task_changed", "lead_overdue", "digest_morning", "digest_evening",
];

export type Permission = NotificationPermission | "unsupported";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    VAPID_PUBLIC.length > 0
  );
}

export function permissionState(): Permission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

function keyToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSw());
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

function subJson(sub: PushSubscription): { endpoint: string; p256dh: string; auth: string } | null {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return null;
  return { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth };
}

export type EnableResult = { ok: true; endpoint: string } | { ok: false; error: string };

/** Minta izin, berlangganan, dan simpan langganan ini di database. */
export async function enablePush(member: string | null, kinds: NotifKind[]): Promise<EnableResult> {
  if (!pushSupported()) {
    return { ok: false, error: "Browser ini belum mendukung notifikasi push. Di iPhone, tambahkan situs ke Layar Utama dulu." };
  }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm === "denied") {
    return { ok: false, error: "Izin notifikasi diblokir. Buka pengaturan situs di browser, ubah Notifikasi menjadi Izinkan, lalu coba lagi." };
  }
  if (perm !== "granted") return { ok: false, error: "Izin notifikasi belum diberikan." };
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSw());
    if (!reg) return { ok: false, error: "Service worker tidak bisa dipasang di browser ini." };
    await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(VAPID_PUBLIC) }));
    const j = subJson(sub);
    if (!j) return { ok: false, error: "Langganan push tidak lengkap. Coba lagi." };
    const saved = await saveSubscription(j, member, kinds, navigator.userAgent);
    if (!saved.ok) return { ok: false, error: saved.error };
    return { ok: true, endpoint: j.endpoint };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return { ok: false, error: msg ? `Gagal mengaktifkan notifikasi: ${msg}` : "Gagal mengaktifkan notifikasi." };
  }
}

export async function updatePushPrefs(member: string | null, kinds: NotifKind[]): Promise<EnableResult> {
  const sub = await currentSubscription();
  if (!sub) return { ok: false, error: "Perangkat ini belum berlangganan." };
  const j = subJson(sub);
  if (!j) return { ok: false, error: "Langganan push tidak lengkap." };
  const saved = await saveSubscription(j, member, kinds, navigator.userAgent);
  return saved.ok ? { ok: true, endpoint: j.endpoint } : { ok: false, error: saved.error };
}

export async function disablePush(): Promise<{ ok: boolean; error?: string }> {
  const sub = await currentSubscription();
  if (!sub) return { ok: true };
  const r = await removeSubscription(sub.endpoint);
  try {
    await sub.unsubscribe();
  } catch {
    /* sudah tidak aktif */
  }
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function loadPrefs(): Promise<{ member: string | null; kinds: NotifKind[] } | null> {
  const sub = await currentSubscription();
  if (!sub) return null;
  const r = await getSubscription(sub.endpoint);
  if (!r.ok || !r.data) return null;
  return { member: r.data.member_name, kinds: r.data.kinds as NotifKind[] };
}

export type TestResult = { ok: true; status: number } | { ok: false; error: string };

/** Kirim notifikasi uji ke perangkat ini. Hasilnya adalah jawaban nyata layanan push. */
export async function sendTestPush(): Promise<TestResult> {
  const sub = await currentSubscription();
  if (!sub) return { ok: false, error: "Perangkat ini belum berlangganan notifikasi." };
  const supa = getSupabase();
  const session = supa ? (await supa.auth.getSession()).data.session : null;
  if (!session) return { ok: false, error: "Sesi login berakhir. Masuk lagi." };
  try {
    const res = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; status?: number; error?: string };
    if (res.ok && body.ok) return { ok: true, status: body.status ?? 201 };
    return { ok: false, error: body.error ?? `Pengiriman gagal (kode ${res.status}).` };
  } catch {
    return { ok: false, error: "Tidak bisa menghubungi server. Periksa internet." };
  }
}
