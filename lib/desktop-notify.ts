// Notifikasi sistem (pojok layar) yang tidak butuh server push. Bekerja selama tab Jobdesk masih terbuka,
// walau pengguna sedang di tab atau aplikasi lain. Untuk browser yang ditutup total, gunakan Web Push.
import { registerSw } from "./notifications";

export const canNotify = (): boolean => typeof window !== "undefined" && "Notification" in window;
export const notifyPermission = (): NotificationPermission | "unsupported" => (canNotify() ? Notification.permission : "unsupported");

export async function askNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!canNotify()) return "unsupported";
  const p = await Notification.requestPermission();
  if (p === "granted") await registerSw();
  return p;
}

export async function showDesktopNotice(id: string, title: string, body: string): Promise<boolean> {
  if (!canNotify() || Notification.permission !== "granted") return false;
  const opts: NotificationOptions & { renotify?: boolean } = {
    body, icon: "/logo.png", badge: "/logo.png", tag: `jobdesk-alert-${id}`, renotify: true, requireInteraction: true,
    data: { url: "/" },
  };
  try {
    let reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (!reg && (await registerSw())) reg = await navigator.serviceWorker.ready; // tunggu service worker aktif
    if (reg) {
      await reg.showNotification(title, opts);
      return true;
    }
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch {
    return false;
  }
}
