import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleScheduledPush, handleTestPush, validEndpoint, type SendResult } from "../lib/push-server";

const sub = (host = "fcm.googleapis.com") => ({ endpoint: `https://${host}/wpush/abc`, p256dh: "p", auth: "a" });
const mk = (send: (s: unknown) => Promise<{ status: number }>) => {
  const confirmed: { id: number; results: SendResult[] }[] = [];
  return { confirmed, deps: { secret: "rahasia", send: send as never, confirm: async (id: number, results: SendResult[]) => { confirmed.push({ id, results }); return true; } } };
};
const body = (subs: unknown[]) => ({ id: 7, title: "T", body: "B", urgent: true, subscriptions: subs });

describe("route push terjadwal", () => {
  it("menolak tanpa atau dengan secret salah, tidak mengirim apa pun", async () => {
    let sent = 0;
    const { deps, confirmed } = mk(async () => { sent++; return { status: 201 }; });
    assert.equal((await handleScheduledPush(null, body([sub()]), deps)).status, 401);
    assert.equal((await handleScheduledPush("salah", body([sub()]), deps)).status, 401);
    assert.equal((await handleScheduledPush("rahasia", body([sub()]), { ...deps, secret: undefined })).status, 401);
    assert.equal(sent, 0);
    assert.equal(confirmed.length, 0);
  });
  it("mengirim ke tiap langganan dan melaporkan hasil nyata, termasuk yang gagal", async () => {
    const { deps, confirmed } = mk(async (s) => {
      if ((s as { endpoint: string }).endpoint.includes("mozilla")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return { status: 201 };
    });
    const r = await handleScheduledPush("rahasia", body([sub(), sub("updates.push.services.mozilla.com")]), deps);
    assert.equal(r.status, 200);
    assert.deepEqual(confirmed[0].results.map((x) => [x.ok, x.status]), [[true, 201], [false, 410]]);
  });
  it("endpoint di luar layanan push dikenal ditolak tanpa dikirim", async () => {
    let sent = 0;
    const { deps, confirmed } = mk(async () => { sent++; return { status: 201 }; });
    await handleScheduledPush("rahasia", body([sub("evil.example.com"), { endpoint: "http://fcm.googleapis.com/x", p256dh: "p", auth: "a" }]), deps);
    assert.equal(sent, 0);
    assert.deepEqual(confirmed[0].results.map((x) => x.ok), [false, false]);
  });
  it("data tidak valid ditolak 400", async () => {
    const { deps } = mk(async () => ({ status: 201 }));
    assert.equal((await handleScheduledPush("rahasia", { id: "x" }, deps)).status, 400);
    assert.equal((await handleScheduledPush("rahasia", null, deps)).status, 400);
  });
  it("validEndpoint", () => {
    assert.equal(validEndpoint("https://fcm.googleapis.com/x"), true);
    assert.equal(validEndpoint("https://fcm.googleapis.com.evil.com/x"), false);
    assert.equal(validEndpoint("javascript:alert(1)"), false);
  });
});

describe("route push uji", () => {
  const s = { endpoint: sub().endpoint, keys: { p256dh: "p", auth: "a" } };
  it("tanpa login ditolak", async () => {
    let sent = 0;
    const r = await handleTestPush(false, { subscription: s }, { send: async () => { sent++; return { status: 201 }; } });
    assert.equal(r.status, 401);
    assert.equal(sent, 0);
  });
  it("sukses hanya bila layanan push menjawab 2xx", async () => {
    assert.equal((await handleTestPush(true, { subscription: s }, { send: async () => ({ status: 201 }) })).body.ok, true);
    const bad = await handleTestPush(true, { subscription: s }, { send: async () => { throw Object.assign(new Error("x"), { statusCode: 410 }); } });
    assert.equal(bad.status, 502);
    assert.match(String(bad.body.error), /kedaluwarsa/);
  });
  it("langganan tidak valid ditolak", async () => {
    assert.equal((await handleTestPush(true, { subscription: { endpoint: "https://evil.example.com/x", keys: { p256dh: "p", auth: "a" } } }, { send: async () => ({ status: 201 }) })).status, 400);
  });
});
