import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMigrationFollowUp } from "@/lib/migration-invite-otp";
import { retryPendingLegacyLockouts } from "@/lib/first-login-migration";

export const dynamic = "force-dynamic";

// POST /api/migration/send-follow-ups — daily cron (EasyCron).
// Auth: X-Cron-Secret header matching CRON_SECRET env var.
//
// The force-migration drip (spec: force-migration-spec.md). Finds invited-but-
// not-migrated dealers overdue for their next follow-up, sends it (fresh code +
// escalating copy), and advances dealers.force_drip_stage.
//
// Schedule, in days since invited_at:  stage 1 → Day 14 · 2 → Day 21 · 3 → Day 23
// Stage 3 is the MANDATORY FINAL NOTICE and stamps final_notice_at, which is
// what makes a dealer eligible to appear in the Force Migration queue.
//
// This REPLACED the old 3/10/30/60/90 drip (Allan, 2026-09-27). It deliberately
// runs on its own counter (force_drip_stage) rather than the legacy
// invite_follow_up_count: most of the backlog already sits at 1–5 on the old
// track, so reusing that column would permanently exclude the longest-stalled
// dealers — exactly the ones this feature exists to clear.
//
// One stage per dealer per run: a long-invited dealer past all three thresholds
// escalates over three consecutive days rather than getting three emails at once.

const SCHEDULE_DAYS = [14, 21, 23] as const; // indexed by force_drip_stage
const MAX_STAGE = SCHEDULE_DAYS.length;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  // force_drip_stage is migration 161 — not in the generated DB types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (admin
    .from("dealers")
    .select("id, name, invited_at, force_drip_stage") as any)
    .eq("migration_status", "invited")
    .eq("active", true)
    .lt("force_drip_stage", MAX_STAGE)
    .not("invited_at", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const dealers = (data ?? []) as DripDealer[];

  // Fire-and-forget so EasyCron sees a fast 200 (same pattern as
  // sync-hubspot-computed); results land in the PM2 log.
  const responseData = { queued: dealers.length };
  void processFollowUps(dealers);
  // Same daily tick: finish any 4.0 lockout that failed or timed out at
  // migration time (first-login migrations land the user before 4.0 answers).
  void retryPendingLegacyLockouts(admin).catch((e) => console.error("[lockout-sweep] failed:", e instanceof Error ? e.message : e));
  return NextResponse.json(responseData);
}

interface DripDealer { id: string; name: string; invited_at: string | null; force_drip_stage: number | null }

async function processFollowUps(dealers: DripDealer[]) {
  const now = Date.now();
  // `sent` used to be incremented for any call that didn't throw — but
  // sendMigrationFollowUp swallows per-recipient mail failures and returns
  // { ok:false, warning } instead of throwing. A dealer whose only contact has
  // hard-bounced therefore logged as "sent" while nothing left the building, and
  // its stage never advanced, so it silently re-attempted every night forever
  // (the class found 2026-08-04: dealers stuck in the drip for weeks behind a
  // bouncing address). Counting delivery separately makes those dealers visible.
  const results = {
    sent: 0,            // at least one recipient actually received it
    notDelivered: 0,    // attempted, but every recipient failed / all completed
    skipped: 0,
    failed: 0,
    finalNotices: 0,
    undeliverable: [] as string[],
    errors: [] as string[],
  };

  for (const dealer of dealers) {
    if (!dealer.invited_at) { results.skipped++; continue; }

    const daysSinceInvite = (now - new Date(dealer.invited_at).getTime()) / (1000 * 60 * 60 * 24);
    const stageIndex = dealer.force_drip_stage ?? 0; // 0 = none sent yet
    const daysThreshold = SCHEDULE_DAYS[stageIndex];

    if (daysThreshold === undefined || daysSinceInvite < daysThreshold) {
      results.skipped++;
      continue;
    }

    const followUpNumber = (stageIndex + 1) as 1 | 2 | 3;
    try {
      const res = await sendMigrationFollowUp(dealer.id, followUpNumber);
      if (res.ok) {
        results.sent++;
        if (followUpNumber === MAX_STAGE) results.finalNotices++;
      } else {
        results.notDelivered++;
        results.undeliverable.push(`${dealer.name}: ${res.warning ?? "no recipient received it"}`);
      }
    } catch (e) {
      results.failed++;
      results.errors.push(`${dealer.name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Small delay to avoid hammering Mandrill
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("[migration-follow-ups]", results);
}
