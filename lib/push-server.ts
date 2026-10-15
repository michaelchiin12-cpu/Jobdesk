// Logika route push, dipisah dari Next agar bisa diuji dengan pengganti (fake).
import { timingSafeEqual } from "node:crypto";

export interface PushSub { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { id?: number; title: string; body: string; urgent?: boolean }
export interface SendResult { endpoint: string; ok: boolean; status: number }

export interface PushDeps {
  secret: string | undefined;
  send: (sub: PushSub, payload: PushPayload) => Promise<{ status: number }>;
  confirm: (id: number, results: SendResult[]) => Promise<boolean>;
}

const ALLOWED_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)googleapis\.com$/,
];

/** Hanya layanan push browser yang dikenal; mencegah server dipakai untuk menembak alamat lain. */
export function validEndpoint(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 1000) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export function validSub(s: unknown): s is PushSub {
  const x = s as Partial<PushSub> | null;
  return !!x && validEndpoint(x.endpoint) && typeof x.p256dh === "string" && x.p256dh.length < 200 && typeof x.auth === "string" && x.auth.length < 100;
}

export function secretMatches(given: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface Reply { status: number; body: Record<string, unknown> }

/** Dipanggil oleh pg_net dari database. Mengirim ke setiap langganan lalu melaporkan hasil nyatanya. */
export async function handleScheduledPush(headerSecret: string | null, body: unknown, deps: PushDeps): Promise<Reply> {
  if (!secretMatches(headerSecret, deps.secret)) return { status: 401, body: { error: "Tidak diizinkan" } };
  const b = body as { id?: unknown; title?: unknown; body?: unknown; urgent?: unknown; subscriptions?: unknown } | null;
  if (!b || typeof b.id !== "number" || typeof b.title !== "string" || !Array.isArray(b.subscriptions) || b.subscriptions.length > 200) {
    return { status: 400, body: { error: "Data tidak valid" } };
  }
  const payload: PushPayload = { id: b.id, title: b.title.slice(0, 120), body: String(b.body ?? "").slice(0, 300), urgent: b.urgent === true };
  const results: SendResult[] = [];
  for (const s of b.subscriptions) {
    if (!validSub(s)) {
      results.push({ endpoint: String((s as PushSub | null)?.endpoint ?? ""), ok: false, status: 400 });
      continue;
    }
    try {
      const r = await deps.send(s, payload);
      results.push({ endpoint: s.endpoint, ok: r.status >= 200 && r.status < 300, status: r.status });
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 0;
      results.push({ endpoint: s.endpoint, ok: false, status });
    }
  }
  const confirmed = await deps.confirm(b.id, results);
  return { status: 200, body: { ok: true, sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, confirmed } };
}

/** Notifikasi uji dari pengguna yang sudah login, hanya ke langganan miliknya sendiri. */
export async function handleTestPush(authorized: boolean, body: unknown, deps: Pick<PushDeps, "send">): Promise<Reply> {
  if (!authorized) return { status: 401, body: { error: "Sesi login tidak valid. Masuk lagi." } };
  const sub = (body as { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } } | null)?.subscription;
  const s = { endpoint: sub?.endpoint, p256dh: sub?.keys?.p256dh, auth: sub?.keys?.auth };
  if (!validSub(s)) return { status: 400, body: { error: "Langganan perangkat tidak valid." } };
  try {
    const r = await deps.send(s, { title: "Notifikasi uji Jobdesk CS", body: "Jika ini muncul, notifikasi di perangkat ini berfungsi." });
    if (r.status >= 200 && r.status < 300) return { status: 200, body: { ok: true, status: r.status } };
    return { status: 502, body: { ok: false, error: `Layanan push menolak (kode ${r.status}).` } };
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    const msg = code === 404 || code === 410 ? "Langganan perangkat ini sudah kedaluwarsa. Matikan lalu aktifkan lagi." : "Layanan push tidak bisa dihubungi.";
    return { status: 502, body: { ok: false, error: msg } };
  }
}
