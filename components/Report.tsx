"use client";

import { useEffect, useMemo, useState } from "react";
import { useData } from "./DataProvider";
import { Empty } from "./ui";
import * as api from "@/lib/api";
import { toCsv, TASK_CSV_HEADERS, taskCsvRows } from "@/lib/csv";
import { buildReport, dueCohort, fetchWindow, PERIOD_LABEL, rangeFor, shiftAnchor, type Period } from "@/lib/metrics";
import { memberNames, MIN_SAMPLES } from "@/lib/tasks";
import { dayKey, fmtDuration, fmtKeyShort } from "@/lib/tz";
import { LATE_REASON_LABEL, type LateReason, type Task } from "@/lib/types";

function TrendChart({ points }: { points: { key: string; completed: number; late: number }[] }) {
  const w = 720, h = 200, pl = 30, pb = 26, pt = 8;
  const max = Math.max(1, ...points.flatMap((p) => [p.completed, p.late]));
  const top = Math.ceil(max / 2) * 2 || 2;
  const slot = (w - pl) / points.length;
  const bw = Math.min(16, slot / 2.6);
  const y = (v: number) => pt + (h - pt - pb) * (1 - v / top);
  const label = (k: string) => k.slice(8) + "/" + k.slice(5, 7);
  const step = Math.ceil(points.length / 10);
  return (
    <figure style={{ margin: 0 }}>
      <div className="chart-legend"><span><i style={{ background: "var(--teal)" }} />Selesai</span><span><i style={{ background: "var(--red)" }} />Terlambat (jatuh tempo)</span></div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Grafik jobdesk selesai dan terlambat per hari">
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line x1={pl} x2={w} y1={y(top * r)} y2={y(top * r)} stroke="var(--line)" />
            <text x={pl - 6} y={y(top * r) + 4} textAnchor="end" fontSize="11" fill="var(--faint)">{Math.round(top * r)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = pl + slot * i + slot / 2;
          return (
            <g key={p.key}>
              <title>{`${fmtKeyShort(p.key)}: ${p.completed} selesai, ${p.late} terlambat`}</title>
              <rect x={cx - bw - 1} y={y(p.completed)} width={bw} height={Math.max(0, y(0) - y(p.completed))} rx="2" fill="var(--teal)" />
              <rect x={cx + 1} y={y(p.late)} width={bw} height={Math.max(0, y(0) - y(p.late))} rx="2" fill="var(--red)" />
              {i % step === 0 && <text x={cx} y={h - 8} textAnchor="middle" fontSize="11" fill="var(--faint)">{label(p.key)}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function download(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Report() {
  const d = useData();
  const [period, setPeriod] = useState<Period>("week");
  const [anchor, setAnchor] = useState(() => dayKey(Date.now()));
  const [pic, setPic] = useState("all");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [err, setErr] = useState("");
  const [truncated, setTruncated] = useState(false);
  const range = useMemo(() => rangeFor(period, anchor), [period, anchor]);

  useEffect(() => {
    let off = false;
    setTasks(null); setErr("");
    const w = fetchWindow(range);
    api.fetchReportTasks(w.from, w.to, range.from).then((r) => {
      if (off) return;
      if (r.ok) { setTasks(r.data.tasks); setTruncated(r.data.truncated); } else setErr(r.error);
    });
    return () => { off = true; };
  }, [range]);

  const now = Date.now();
  const report = useMemo(() => (tasks ? buildReport(tasks, range, now, pic) : null), [tasks, range, pic, now]);
  const cohort = useMemo(() => (tasks ? dueCohort(tasks, range, pic) : []), [tasks, range, pic]);
  const reasons = useMemo(() => {
    const m = new Map<LateReason, number>();
    for (const t of cohort) if (t.late_reason) m.set(t.late_reason, (m.get(t.late_reason) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [cohort]);

  const slug = `${range.fromKey}_${pic === "all" ? "semua" : pic.replace(/\W+/g, "-")}`;
  const exportTasks = () => download(`jobdesk_${slug}.csv`, toCsv(TASK_CSV_HEADERS, taskCsvRows(cohort, now)));
  const exportSummary = () => report && download(`ringkasan_${slug}.csv`, toCsv(
    ["PIC", "Dibuat", "Diselesaikan", "Jatuh tempo", "Tepat waktu", "Selesai terlambat", "Belum selesai lewat deadline", "Belum jatuh tempo", "Ketepatan waktu (%)"],
    report.perPic.map((r) => [r.pic, r.created, r.completed, r.due, r.onTime, r.doneLate, r.openLate, r.upcoming, r.onTimePct === null ? "" : r.onTimePct]),
  ));

  const t = report?.totals;
  return (
    <>
      <div className="page-head">
        <div><h1>Laporan</h1><p className="sub">{range.label}</p></div>
        <div className="page-actions">
          <div className="seg" role="group" aria-label="Periode">
            {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>)}
          </div>
          <button className="btn" aria-label="Periode sebelumnya" onClick={() => setAnchor(shiftAnchor(period, anchor, -1))}>‹</button>
          <button className="btn" onClick={() => setAnchor(dayKey(Date.now()))}>Hari ini</button>
          <button className="btn" aria-label="Periode berikutnya" onClick={() => setAnchor(shiftAnchor(period, anchor, 1))}>›</button>
          <select aria-label="Filter PIC" value={pic} onChange={(e) => setPic(e.target.value)} style={{ width: "auto" }}>
            <option value="all">Semua PIC</option>
            {memberNames(d.members).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      </div>

      {err && <p className="banner-err" role="alert">{err}</p>}
      {truncated && <p className="banner-info">Data sangat banyak, laporan dibatasi 10.000 baris. Persempit periode.</p>}
      {!tasks && !err && <p className="hint" style={{ color: "var(--muted)" }}>Memuat laporan...</p>}

      {report && t && (
        report.hasData ? (
          <>
            <section className="kpis" aria-label="Ringkasan periode">
              <div className="kpi"><span>Dibuat</span><b>{t.created}</b><small>jobdesk baru</small></div>
              <div className="kpi"><span>Diselesaikan</span><b>{t.completed}</b><small>selesai di periode ini</small></div>
              <div className="kpi"><span>Jatuh tempo</span><b>{t.due}</b><small>{t.onTime} tepat waktu</small></div>
              <div className="kpi"><span>Terlambat</span><b style={{ color: t.late ? "var(--red)" : undefined }}>{t.late}</b><small>{t.doneLate} selesai terlambat, {t.openLate} belum selesai</small></div>
              <div className="kpi"><span>Ketepatan waktu</span><b>{t.onTimePct === null ? "-" : `${t.onTimePct}%`}</b><small>{t.determined} jobdesk sudah ada hasilnya</small></div>
              <div className="kpi"><span>Rata-rata pengerjaan</span><b>{report.avgWorkMs === null ? "-" : fmtDuration(report.avgWorkMs)}</b><small>{report.avgWorkMs === null ? `butuh ${MIN_SAMPLES}+ jobdesk berstatus dimulai` : `dari ${report.workSample} jobdesk`}</small></div>
            </section>
            <section className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-head"><h2>Tren harian</h2></div>
              <TrendChart points={report.trend} />
            </section>
            <section className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-head"><h2>Per PIC</h2></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>PIC</th><th className="num">Dibuat</th><th className="num">Selesai</th><th className="num">Jatuh tempo</th><th className="num">Tepat waktu</th><th className="num">Terlambat</th><th className="num">Ketepatan</th></tr></thead>
                  <tbody>
                    {report.perPic.map((r) => (
                      <tr key={r.pic}><td>{r.pic}</td><td className="num">{r.created}</td><td className="num">{r.completed}</td><td className="num">{r.due}</td><td className="num">{r.onTime}</td><td className="num">{r.late}</td><td className="num">{r.onTimePct === null ? "-" : `${r.onTimePct}%`}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel" style={{ marginBottom: 14 }}>
              <div className="panel-head"><h2>Alasan keterlambatan</h2></div>
              {reasons.length === 0 ? <p className="hint" style={{ color: "var(--faint)" }}>Belum ada alasan yang dicatat pada periode ini.</p> : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>{reasons.map(([k, n]) => <li key={k}>{LATE_REASON_LABEL[k]}: {n}</li>)}</ul>
              )}
            </section>
            <div className="page-actions">
              <button className="btn primary" onClick={exportTasks} disabled={cohort.length === 0}>Unduh daftar jobdesk (CSV)</button>
              <button className="btn" onClick={exportSummary}>Unduh ringkasan per PIC (CSV)</button>
            </div>
            <p className="hint" style={{ color: "var(--faint)", marginTop: 12, maxWidth: 720 }}>
              Ketepatan waktu = selesai sebelum deadline dibagi semua jobdesk jatuh tempo yang hasilnya sudah jelas. Jobdesk yang belum jatuh tempo tidak dihitung. Jobdesk yang diarsipkan tidak termasuk.
            </p>
          </>
        ) : (
          <Empty title="Belum ada data di periode ini" body="Pilih periode lain atau tambahkan jobdesk dengan deadline di rentang ini." />
        )
      )}
    </>
  );
}
