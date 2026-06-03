import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendPasskeyInvite } from "@/lib/migration-invite";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/onboard/resend  { email }
// Re-issues a fresh 6-digit onboarding code (generateLink invalidates the prior
// one) and re-emails it. Unauthenticated (the dealer isn't signed in yet), so:
//   - rate-limited per IP,
//   - always returns { ok: true } regardless of whether the email exists, to
//     avoid leaking which emails have accounts / enumerating users.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!rateLimit(`onboard-resend:${ip}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests — please wait a moment." }, { status: 429 });
  }

  let email: string | undefined;
  try {
    ({ email } = (await req.json()) as { email?: string });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  email = email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  try {
    const admin = createAdminSupabaseClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, dealer_id, group_id")
      .ilike("email", email)
      .maybeSingle<{ full_name: string | null; dealer_id: string | null; group_id: string | null }>();

    // Only actually send when an account exists — but don't reveal either way.
    if (profile) {
      let entityName = "your account";
      if (profile.dealer_id) {
        const { data: d } = await admin
          .from("dealers").select("name").eq("dealer_id", profile.dealer_id)
          .maybeSingle<{ name: string | null }>();
        entityName = d?.name ?? entityName;
      } else if (profile.group_id) {
        const { data: g } = await admin
          .from("groups").select("name").eq("id", profile.group_id)
          .maybeSingle<{ name: string | null }>();
        entityName = g?.name ?? entityName;
      }
      await sendPasskeyInvite({ email, fullName: profile.full_name, entityName });
    }
  } catch (err) {
    // Swallow — never leak whether the email exists or why a send failed.
    console.error("[onboard/resend] failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
