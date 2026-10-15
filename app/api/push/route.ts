import { NextResponse } from "next/server";
import { handleScheduledPush } from "@/lib/push-server";
import { deps } from "@/lib/push-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const r = await handleScheduledPush(req.headers.get("x-push-secret"), body, deps());
  return NextResponse.json(r.body, { status: r.status });
}
