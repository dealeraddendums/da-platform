import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMigrationFollowUp } from "@/lib/migration-invite-otp";

export const dynamic = "force-dynamic";

// POST /api/migration/send-follow-ups — daily cron (EasyCron).
// Auth: X-Cron-Secret header matching CRON_SECRET env var.
// Finds all invited-but-not-migrated dealers who are overdue for their next
// drip follow-up, sends it (fresh code + escalating copy), and increments
// dealers.invite_follow_up_count. Max 5 follow-ups; a manual resend resets
// the count to 0 so the drip restarts.
// Schedule (days since invited_at): 1→Day 3, 2→Day 10, 3→Day 30, 4→Day 60, 5→Day 90

const SCHEDULE_DAYS = [3, 10, 30, 60, 90]; // indexed by invite_follow_up_count

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  // invited_at / invite_follow_up_count aren't in the generated DB types yet
  // (migrations 050/124) — same `as any` pattern as billing-pending.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin
    .from("dealers")
    .select("id, name, invited_at, invite_follow_up_count") as any)
    .eq("migration_status", "invited")
    .eq("active", true)
    .lt("invite_follow_up_count", 5)
    .not("invited_at", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const dealers = (data ?? []) as Array<{ id: string; name: string; invited_at: string | null; invite_follow_up_count: number }>;

  // Fire-and-forget so EasyCron sees a fast 200 (same pattern as
  // sync-hubspot-computed); results land in the PM2 log.
  const responseData = { queued: dealers.length };
  void processFollowUps(dealers);
  return NextResponse.json(responseData);
}

async function processFollowUps(dealers: Array<{ id: string; name: string; invited_at: string | null; invite_follow_up_count: number }>) {
  const now = Date.now();
  const results = { sent: 0, skipped: 0, failed: 0, errors: [] as string[] };

  for (const dealer of dealers) {
    if (!dealer.invited_at) { results.skipped++; continue; }

    const invitedAt = new Date(dealer.invited_at).getTime();
    const daysSinceInvite = (now - invitedAt) / (1000 * 60 * 60 * 24);
    const nextFollowUpIndex = dealer.invite_follow_up_count; // 0 = none sent yet
    const daysThreshold = SCHEDULE_DAYS[nextFollowUpIndex];

    if (daysThreshold === undefined || daysSinceInvite < daysThreshold) {
      results.skipped++;
      continue;
    }

    const followUpNumber = (nextFollowUpIndex + 1) as 1 | 2 | 3 | 4 | 5;
    try {
      await sendMigrationFollowUp(dealer.id, followUpNumber);
      results.sent++;
    } catch (e) {
      results.failed++;
      results.errors.push(`${dealer.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Small delay to avoid hammering Mandrill
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("[migration-follow-ups]", results);
}
