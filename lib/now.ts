"use client";
import { useSyncExternalStore } from "react";

// Satu pencacah waktu bersama. Komponen memilih kerapatan sendiri (1 dtk untuk jam, 20 dtk untuk daftar),
// jadi seluruh aplikasi tidak digambar ulang tiap detik.
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) timer = setInterval(() => listeners.forEach((l) => l()), 1000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Waktu sekarang (ms) yang dibulatkan ke `step` ms. Di server menghasilkan 0 agar hidrasi konsisten. */
export function useNow(step = 20000): number {
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / step) * step,
    () => 0,
  );
}
