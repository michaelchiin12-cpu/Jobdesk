let ctx: AudioContext | null = null;

/** Tiga bunyi pendek. Browser menolak suara sebelum pengguna pernah menyentuh halaman; kegagalan diabaikan. */
export function beep(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = ctx ?? new AC();
    void ctx.resume();
    const t0 = ctx.currentTime;
    [0, 0.28, 0.56].forEach((d, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = "sine";
      o.frequency.value = i === 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.3, t0 + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.22);
      o.connect(g).connect(ctx!.destination);
      o.start(t0 + d);
      o.stop(t0 + d + 0.25);
    });
  } catch { /* abaikan */ }
}
