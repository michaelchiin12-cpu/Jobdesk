// Penghubung ke web-push dan Supabase untuk route push. Tidak diuji unit; logikanya ada di push-server.ts.
import webpush from "web-push";
import type { PushDeps, PushPayload, PushSub, SendResult } from "./push-server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

let ready = false;
export function vapidReady(): boolean {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (!ready) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", pub, priv);
    ready = true;
  }
  return true;
}

export async function sendOne(sub: PushSub, payload: PushPayload): Promise<{ status: number }> {
  if (!vapidReady()) throw Object.assign(new Error("VAPID belum dikonfigurasi"), { statusCode: 0 });
  const r = await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { TTL: 600, urgency: payload.urgent ? "high" : "normal" },
  );
  return { status: r.statusCode };
}

export async function confirmInDb(id: number, results: SendResult[]): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/confirm_push`, {
      method: "POST",
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_secret: process.env.PUSH_SECRET, p_id: id, p_results: results }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Periksa token pengguna ke Supabase Auth, lalu pastikan akun punya peran di aplikasi. */
export async function userHasRole(authHeader: string | null): Promise<boolean> {
  const token = authHeader?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !SUPABASE_URL) return false;
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (!u.ok) return false;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/my_role`, {
      method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
    });
    if (!r.ok) return false;
    const role = await r.json();
    return role === "lead" || role === "cs";
  } catch {
    return false;
  }
}

export const deps = (): PushDeps => ({ secret: process.env.PUSH_SECRET, send: sendOne, confirm: confirmInDb });
