import { NextRequest, NextResponse } from "next/server";
import { getJwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

// GET /api/check-email?email=… → { available: boolean }
//
// Real-time availability check for the dealer-creation forms (SuperAdmin +
// Group Admin) and the marketing-site self-serve signup. Availability =
// no profiles row with that email (case-insensitive).
//
// Auth: a logged-in platform session (cookie or Bearer) OR the marketing
// site's X-API-Key matching SELF_SERVE_API_KEY (da-marketing-os proxies
// browser requests through its own server route so the key never ships to
// the client). Deliberately returns ONLY the boolean — never which dealer
// or user owns the email.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── Auth: session OR self-serve API key ──────────────────────────────────
  const selfServeKey = process.env.SELF_SERVE_API_KEY;
  const keyOk = !!selfServeKey && req.headers.get("x-api-key") === selfServeKey;
  if (!keyOk) {
    const claims = await getJwtClaims();
    if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Rate limit: modest per-IP guard (the data is a boolean, but don't let
  //    anyone enumerate the user base) ────────────────────────────────────────
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`check-email:${ip}`, 30, 60_000)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const email = req.nextUrl.searchParams.get("email")?.trim().toLowerCase() ?? "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    // Fail open — the create routes still enforce uniqueness server-side;
    // this endpoint is a UX nicety and must never hard-block on a db blip.
    console.error("[check-email] lookup failed:", error.message);
    return NextResponse.json({ available: true });
  }

  return NextResponse.json({ available: !data });
}
