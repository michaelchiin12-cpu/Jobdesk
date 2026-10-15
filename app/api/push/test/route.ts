import { NextResponse } from "next/server";
import { handleTestPush } from "@/lib/push-server";
import { sendOne, userHasRole, vapidReady } from "@/lib/push-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!vapidReady()) {
    return NextResponse.json({ ok: false, error: "Kunci push belum dipasang di server (VAPID)." }, { status: 503 });
  }
  const authorized = await userHasRole(req.headers.get("authorization"));
  const body = await req.json().catch(() => null);
  const r = await handleTestPush(authorized, body, { send: sendOne });
  return NextResponse.json(r.body, { status: r.status });
}
