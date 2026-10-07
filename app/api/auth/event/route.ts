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
import { createClient } from "@/lib/supabase/server";
import { migrateOnFirstDealerLogin, LIVE_ON_5_COOKIE, LIVE_ON_5_COOKIE_MAX_AGE } from "@/lib/first-login-migration";

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

  // First-login migration for emailed-code logins. The code is verified in the
  // browser, so the browser's report is NOT trusted on its own: we act only
  // when THIS request carries the freshly-minted session cookie and that
  // session's own email matches the report. No session (a failed login, a
  // forged report) → nothing happens. Impersonation/ghost never come through
  // the code form.
  if (body.event === "otp_verify" && body.result === "success") {
    try {
      const { data: { user } } = await createClient().auth.getUser();
      const claimed = (body.email ?? "").trim().toLowerCase();
      if (user?.id && user.email && user.email.toLowerCase() === claimed) {
        const first = await migrateOnFirstDealerLogin({ userId: user.id, email: user.email, via: "otp" });
        if (first.usable && first.migratedNow) {
          const res = new NextResponse(null, { status: 204 });
          res.cookies.set(LIVE_ON_5_COOKIE, "1", { path: "/", maxAge: LIVE_ON_5_COOKIE_MAX_AGE, sameSite: "lax", secure: true });
          return res;
        }
      }
    } catch (e) {
      console.error("[auth/event] first-login migration check failed:", e instanceof Error ? e.message : e);
    }
  }

  // Always 204 — the response must not tell a caller anything about the account.
  return new NextResponse(null, { status: 204 });
}
