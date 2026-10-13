"use client";

import type { Member } from "@/lib/types";
import { isAbsent } from "@/lib/time";

interface Props {
  current: string;
  members: Member[];
  today: string;
  inAlert?: boolean;
  disabled?: boolean;
  onPick: (name: string) => void;
}

export default function PicSelect({ current, members, today, inAlert = false, disabled = false, onPick }: Props) {
  const names = members.map((m) => m.name);
  const base = !inAlert && !names.includes(current) ? [current, ...names] : names;
  const list = base.filter((n) => !(inAlert && (n === current || isAbsent(members, n, today))));
  return (
    <select
      aria-label="Alihkan PIC"
      disabled={disabled}
      value={inAlert ? "" : current}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
      }}
    >
      {inAlert && <option value="">Alihkan ke...</option>}
      {list.map((n) => (
        <option key={n} value={n}>
          {n}
          {isAbsent(members, n, today) ? " (tidak masuk)" : ""}
        </option>
      ))}
    </select>
  );
}
