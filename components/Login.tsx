"use client";

import Image from "next/image";
import { useState, type FormEvent } from "react";
import { getSupabase, isConfigured, LEAD_EMAIL, TEAM_EMAIL } from "@/lib/supabase";

export default function Login() {
  const [who, setWho] = useState<"cs" | "lead">("cs");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    if (!sb) return setErr("Koneksi database belum diatur. Hubungi pengelola.");
    if (!code.trim()) return setErr("Isi kode akses.");
    setBusy(true);
    setErr("");
    const { error } = await sb.auth.signInWithPassword({ email: who === "lead" ? LEAD_EMAIL : TEAM_EMAIL, password: code.trim() });
    setBusy(false);
    if (error) setErr(error.status === 400 ? "Kode akses salah." : "Tidak bisa terhubung. Periksa internet lalu coba lagi.");
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="brand">
          <Image src="/logo.png" alt="" width={34} height={34} priority />
          <b>Jobdesk CS</b>
        </div>
        <h1>Masuk</h1>
        <p className="sub">Pilih peran, lalu masukkan kode akses.</p>
        <div className="seg" role="group" aria-label="Peran" style={{ marginBottom: 16 }}>
          <button type="button" aria-pressed={who === "cs"} onClick={() => setWho("cs")}>Tim CS</button>
          <button type="button" aria-pressed={who === "lead"} onClick={() => setWho("lead")}>CS Lead</button>
        </div>
        <div className="field">
          <label htmlFor="code">Kode akses {who === "lead" ? "CS Lead" : "tim"}</label>
          <input id="code" type="password" autoComplete="current-password" value={code} onChange={(e) => setCode(e.target.value)} disabled={busy || !isConfigured} data-autofocus />
        </div>
        {err && <p className="msg" role="alert">{err}</p>}
        {!isConfigured && <p className="msg" role="alert">Alamat dan kunci Supabase belum diisi di pengaturan deployment.</p>}
        <button className="btn primary block" type="submit" disabled={busy || !isConfigured}>{busy ? "Memeriksa..." : "Masuk"}</button>
      </form>
    </main>
  );
}
