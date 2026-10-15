import type { AppNotification } from "./types";

/** Notifikasi yang relevan untuk pengguna ini: umum, untuk PIC yang dipilih, atau semua bila CS Lead. */
export function visibleNotifs(list: AppNotification[], isLead: boolean, me: string | null): AppNotification[] {
  return list.filter((n) => {
    if (n.audience === "all") return true;
    if (n.audience === "lead") return isLead;
    return isLead || (!!me && n.audience_pic === me);
  });
}
