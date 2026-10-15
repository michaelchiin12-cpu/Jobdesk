import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextDates, occursOn } from "../lib/recurrence";

describe("lib/recurrence", () => {
  it("harian dan hari kerja", () => {
    assert.deepEqual(nextDates("daily", null, null, "2026-10-14", "2026-01-01", 2), ["2026-10-14", "2026-10-15"]);
    // 2026-10-16 Jumat, 17-18 akhir pekan
    assert.deepEqual(nextDates("weekdays", null, null, "2026-10-16", "2026-01-01", 3), ["2026-10-16", "2026-10-19", "2026-10-20"]);
  });
  it("mingguan: Senin = 1, Minggu = 7", () => {
    assert.deepEqual(nextDates("weekly", 7, null, "2026-10-14", "2026-01-01", 2), ["2026-10-18", "2026-10-25"]);
    assert.equal(occursOn("weekly", 1, null, "2026-10-19"), true);
  });
  it("bulanan jatuh ke akhir bulan bila tanggalnya tidak ada", () => {
    assert.deepEqual(nextDates("monthly", 31, null, "2026-02-01", "2026-01-01", 1).length, 0);
    assert.deepEqual(nextDates("monthly", null, 31, "2026-02-01", "2026-01-01", 3), ["2026-02-28", "2026-03-31", "2026-04-30"]);
    assert.equal(occursOn("monthly", null, 31, "2028-02-29"), true);
  });
  it("tidak lebih awal dari tanggal mulai", () => {
    assert.equal(nextDates("daily", null, null, "2026-10-01", "2026-10-10", 1)[0], "2026-10-10");
  });
});
