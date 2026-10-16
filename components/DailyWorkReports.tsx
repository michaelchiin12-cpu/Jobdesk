"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Member } from "@/lib/types";

interface Report {
  id: string;
  report_date: string;
  pic_name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function localDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function uniqueJobs(content: string) {
  const seen = new Set<string>();
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => {
    const key = line.replace(/\s+/g, " ").toLocaleLowerCase("id-ID");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((line) => line.replace(/\s+/g, " "));
}

export default function DailyWorkReports({ members }: { members: Member[] }) {
  const [date, setDate] = useState(localDateValue);
  const [pic, setPic] = useState("");
  const [content, setContent] = useState("");
  const [reports, setReports] = useState<Report[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (members.length && !members.some((member) => member.name === pic)) setPic(members[0].name);
    if (!members.length) setPic("");
  }, [members, pic]);

  useEffect(() => {
    let active = true;
    const sb = getSupabase();
    if (!sb) {
      setMessage("Koneksi database belum tersedia.");
      setLoading(false);
      return;
    }
    setLoading(true);
    sb.from("daily_work_reports").select("*").eq("report_date", date).order("pic_name", { ascending: true })
      .then(({ data, error }) => {
        if (!active) return;
        if (error) {
          setMessage("Laporan belum bisa dimuat. Pastikan migrasi database sudah diterapkan.");
          setReports([]);
        } else {
          setMessage("");
          setReports((data ?? []) as Report[]);
        }
        setLoading(false);
      });
    return () => { active = false; };
  }, [date]);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    const channel = sb.channel("daily-work-reports")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_work_reports" }, (payload) => {
        const row = (payload.new ?? payload.old) as Report | undefined;
        if (!row) return;
        if (payload.eventType === "DELETE") {
          setReports((prev) => prev.filter((item) => item.id !== row.id));
        } else if (row.report_date === date) {
          setReports((prev) => {
            const index = prev.findIndex((item) => item.id === row.id);
            if (index < 0) return [...prev, row].sort((a, b) => a.pic_name.localeCompare(b.pic_name));
            const next = [...prev];
            next[index] = row;
            return next;
          });
        } else {
          setReports((prev) => prev.filter((item) => item.id !== row.id));
        }
      }).subscribe();
    return () => { sb.removeChannel(channel); };
  }, [date]);

  const current = reports.find((report) => report.pic_name === pic);
  useEffect(() => {
    setContent(current?.content ?? "");
  }, [current?.id, current?.content, date, pic]);

  const preview = useMemo(() => uniqueJobs(content), [content]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!pic) {
      setMessage("Tambahkan anggota tim terlebih dahulu.");
      return;
    }
    const normalized = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join("\n");
    if (!normalized) {
      setMessage("Isi minimal satu pekerjaan sebelum menyimpan.");
      return;
    }
    const sb = getSupabase();
    if (!sb) return setMessage("Koneksi database belum tersedia.");
    setBusy(true);
    setMessage("");
    const { data, error } = await sb.from("daily_work_reports")
      .upsert({ report_date: date, pic_name: pic, content: normalized }, { onConflict: "report_date,pic_name" })
      .select("*").single();
    setBusy(false);
    if (error || !data) {
      setMessage("Laporan gagal disimpan. Periksa koneksi dan kebijakan database.");
      return;
    }
    setReports((prev) => {
      const next = prev.filter((item) => item.id !== data.id);
      return [...next, data as Report].sort((a, b) => a.pic_name.localeCompare(b.pic_name));
    });
    setContent(normalized);
    setMessage("Laporan berhasil disimpan.");
  }

  async function copyReport(name: string, text: string) {
    const formatted = [name, ...uniqueJobs(text).map((job) => "- " + job)].join("\n");
    try {
      await navigator.clipboard.writeText(formatted);
      setMessage("Laporan " + name + " berhasil disalin untuk LINE.");
    } catch {
      setMessage("Clipboard tidak tersedia. Pilih dan salin teks dari pratinjau.");
    }
  }

  return (
    <section className="card daily-reports" aria-labelledby="daily-report-heading">
      <div className="daily-report-head">
        <div>
          <h2 id="daily-report-heading" className="card-h">Rekap Kerjaan Hari Ini</h2>
          <p className="hint">Input manual PIC, bisa diedit kembali untuk tanggal sebelumnya.</p>
        </div>
        <span className="daily-report-count">{reports.length} PIC</span>
      </div>
      <form onSubmit={save}>
        <div className="daily-report-fields">
          <div className="field">
            <label className="lbl" htmlFor="report-date">Tanggal laporan</label>
            <input id="report-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="lbl" htmlFor="report-pic">Nama PIC</label>
            <select id="report-pic" value={pic} onChange={(e) => setPic(e.target.value)} disabled={!members.length}>
              {!members.length && <option value="">Tambahkan anggota tim dulu</option>}
              {members.map((member) => <option key={member.id} value={member.name}>{member.name}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="lbl" htmlFor="report-content">Daftar pekerjaan (satu pekerjaan per baris)</label>
          <textarea id="report-content" rows={7} maxLength={12000} placeholder={"Cek dan login radar chatplus\nBalas chat marketplace shopee\nIsi KPI harian"} value={content} onChange={(e) => setContent(e.target.value)} disabled={!members.length} />
        </div>
        <div className="daily-report-actions">
          <button className="btn primary" type="submit" disabled={busy || !members.length}>{busy ? "Menyimpan..." : "Simpan laporan"}</button>
          <button className="btn" type="button" onClick={() => void copyReport(pic, content)} disabled={!pic || !preview.length}>Salin laporan untuk LINE</button>
        </div>
      </form>
      {message && <p className="daily-report-message" role="status">{message}</p>}
      <div className="daily-preview">
        <div className="daily-preview-head">
          <h3>Pratinjau LINE</h3>
          <span>{preview.length} pekerjaan unik</span>
        </div>
        <pre>{pic ? [pic, ...preview.map((job) => "- " + job)].join("\n") : "Pilih PIC untuk melihat pratinjau."}</pre>
      </div>
      <div className="daily-saved">
        <h3>Laporan tersimpan · {date}</h3>
        {loading ? <p className="hint">Memuat laporan...</p> : reports.length === 0 ? <p className="hint">Belum ada laporan untuk tanggal ini.</p> : (
          <ul>{reports.map((report) => <li key={report.id}>
            <div><strong>{report.pic_name}</strong><span>{uniqueJobs(report.content).length} pekerjaan unik</span></div>
            <button type="button" className="btn small" onClick={() => { setPic(report.pic_name); setContent(report.content); }}>Edit</button>
            <button type="button" className="btn small" onClick={() => void copyReport(report.pic_name, report.content)}>Salin</button>
          </li>)}</ul>
        )}
      </div>
    </section>
  );
}
