// Browser-reported auth events (migration 155).
//
// The OTP-code and password verifications happen CLIENT-side via supabase-js,
// so no server route sees their outcome. This endpoint lets those flows report
// the attempt; the IP and user-agent are taken from THIS request, not from the
// body, so they can't be spoofed even though the outcome can. Rows land with
// source='client' precisely so a future investigation doesn't over-trust them.
//
// Unauthenticated by necessity (a failed login has no session). Rate-limited,
// and the accepted payload is a closed set.

import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { recordAuthEvent, clientIp, type AuthEventName } from "@/lib/auth-events";

const ALLOWED: ReadonlySet<string> = new Set<AuthEventName>(["otp_verify", "password_verify"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = clientIp(req) ?? "unknown";
  // Generous: a person mistyping a code shouldn't lose their audit trail, but
  // this can't become an unbounded write endpoint either.
  if (!rateLimit(`auth-event:${ip}`, 40, 60_000)) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as
    | { event?: string; result?: string; email?: string; detail?: string }
    | null;
  if (!body?.event || !ALLOWED.has(body.event)) return NextResponse.json({ ok: false }, { status: 400 });
  if (body.result !== "success" && body.result !== "failure") return NextResponse.json({ ok: false }, { status: 400 });

  recordAuthEvent({
    event: body.event as AuthEventName,
    result: body.result,
    email: body.email ?? null,
    detail: body.detail?.slice(0, 200) ?? null,
    req,
    source: "client",
  });
  // Always 204 — the response must not tell a caller anything about the account.
  return new NextResponse(null, { status: 204 });
}
