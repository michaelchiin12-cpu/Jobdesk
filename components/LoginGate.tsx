"use client";

import { useState, type FormEvent } from "react";
import { getSupabase, isConfigured, TEAM_EMAIL } from "@/lib/supabase";

export default function LoginGate() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const sb = getSupabase();
    if (!sb) {
      setErr("Koneksi database belum diatur. Hubungi pengelola papan.");
      return;
    }
    if (!code.trim()) {
      setErr("Isi kode akses tim.");
      return;
    }
    setBusy(true);
    setErr("");
    const { error } = await sb.auth.signInWithPassword({ email: TEAM_EMAIL, password: code.trim() });
    setBusy(false);
    if (error) {
      setErr(error.status === 400 ? "Kode akses salah." : "Tidak bisa terhubung. Periksa internet lalu coba lagi.");
    }
  }

  return (
    <div className="login">
      <h1>Papan Jobdesk</h1>
      <p className="sub">Masukkan kode akses tim untuk membuka papan.</p>
      <form className="card" onSubmit={submit} noValidate>
        <div className="field">
          <label className="lbl" htmlFor="code">Kode akses</label>
          <input
            id="code"
            type="password"
            autoComplete="current-password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy || !isConfigured}
          />
        </div>
        {err && <p className="msg" role="alert">{err}</p>}
        {!isConfigured && (
          <p className="msg" role="alert">Alamat dan kunci Supabase belum diisi di pengaturan deployment.</p>
        )}
        <button className="btn primary block" type="submit" disabled={busy || !isConfigured}>
          {busy ? "Memeriksa..." : "Masuk"}
        </button>
      </form>
    </div>
  );
}
