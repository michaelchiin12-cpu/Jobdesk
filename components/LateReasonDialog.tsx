"use client";

import { useState } from "react";
import { Field, Modal } from "./ui";
import { useData } from "./DataProvider";
import { useToast } from "./Toast";
import { validateLateReason, LATE_NOTE_MAX } from "@/lib/validation";
import type { Task } from "@/lib/types";
import { LATE_REASON_LABEL } from "@/lib/types";
import type { LateReason } from "@/lib/types";

export default function LateReasonDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const d = useData();
  const toast = useToast();
  const [code, setCode] = useState<string>(task.late_reason ?? "");
  const [note, setNote] = useState(task.late_note ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverErr, setServerErr] = useState("");
  const errors = validateLateReason(code, note);

  async function save() {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    const r = await d.lateReason(task.id, code as LateReason, note);
    setBusy(false);
    if (!r.ok) return setServerErr(r.error);
    toast("Alasan keterlambatan dicatat.");
    onClose();
  }

  return (
    <Modal title="Alasan keterlambatan" onClose={onClose} variant="dialog"
      footer={<><button className="btn ghost" onClick={onClose}>Lewati</button><button className="btn primary" onClick={save} disabled={busy}>Simpan alasan</button></>}>
      <p style={{ marginBottom: 14, color: "var(--muted)" }}>&ldquo;{task.title}&rdquo; melewati deadline. Catat alasannya agar CS Lead bisa melihat pola hambatan.</p>
      <Field label="Alasan" error={touched ? errors.reason : undefined} htmlFor="lr">
        <select id="lr" value={code} onChange={(e) => setCode(e.target.value)} data-autofocus>
          <option value="">Pilih alasan</option>
          {(Object.keys(LATE_REASON_LABEL) as LateReason[]).map((k) => <option key={k} value={k}>{LATE_REASON_LABEL[k]}</option>)}
        </select>
      </Field>
      <Field label="Catatan (opsional)" error={touched ? errors.note : undefined} htmlFor="ln" hint={`${note.length}/${LATE_NOTE_MAX}`}>
        <textarea id="ln" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {serverErr && <p className="msg" role="alert">{serverErr}</p>}
    </Modal>
  );
}
