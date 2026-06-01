// EasyCron registration (must be added manually after deploy):
//   Schedule: 0 6 * * *    (daily, 06:00 UTC = 02:00 ET — well before business)
//   URL:      POST https://app.dealeraddendums.com/api/cron/archive-downgraded
//   Header:   x-cron-secret: <CRON_SECRET value from .env.production>

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { archiveCustomer, billingConfigured } from "@/lib/billing";
import { sendMandrillEmail } from "@/lib/mandrill";

/**
 * POST /api/cron/archive-downgraded
 *
 * Phase 14 follow-up Part C — once a dealer's been in the "Downgraded"
 * lifecycle (paying → Free transition) for 60 days, archive the
 * account: flip `dealers.active = false` + stamp `inactivated_at`, and
 * archive their customer in da-billing so no further invoices generate.
 * HubSpot lifecyclestage stays at "Account Downgraded" — Allan
 * confirmed there's no separate "Archived" stage to push to (see
 * docs/hubspot-lifecycle-realtime-and-archive.md confirm #4).
 *
 * Auth: `x-cron-secret` header must match CRON_SECRET. The route also
 * accepts a super_admin session for manual triggering from the Reports
 * page if we wire one.
 *
 * Returns immediately with a queued count then runs the loop in
 * background under PM2 — same pattern as sync-xps-tracking and
 * sync-hubspot-computed (ALB caps at 60s otherwise).
 *
 * Idempotent: skips dealers already at active=false. Per-dealer
 * try/catch so one da-billing flake doesn't abort the batch.
 */

const DOWNGRADED_DAYS_THRESHOLD = 60;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();
  const cutoff = new Date(Date.now() - DOWNGRADED_DAYS_THRESHOLD * 24 * 60 * 60 * 1000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: queued } = await (admin as any)
    .from("dealers")
    .select("id", { count: "exact", head: true })
    .eq("active", true)
    .not("downgraded_at", "is", null)
    .lt("downgraded_at", cutoff) as { count: number | null };

  console.log(`[cron/archive-downgraded] queued: ${queued ?? 0} dealers (downgraded_at < ${cutoff})`);

  void (async () => {
    const stats = {
      processed: 0,
      archived: 0,
      billing_archived: 0,
      billing_skipped_no_customer: 0,
      errors: 0,
    };
    const archivedSummaries: Array<{ dealer_id: string; name: string | null; downgraded_at: string }> = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows } = await (admin as any)
      .from("dealers")
      .select("id, dealer_id, name, billing_customer_id, internal_id, downgraded_at")
      .eq("active", true)
      .not("downgraded_at", "is", null)
      .lt("downgraded_at", cutoff)
      .limit(2000) as { data: Array<{ id: string; dealer_id: string; name: string | null; billing_customer_id: string | null; internal_id: string | null; downgraded_at: string }> | null };

    for (const d of rows ?? []) {
      stats.processed++;
      try {
        // 1. Flip DA-Platform to Inactive (active=false + timestamp).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: uErr } = await (admin as any)
          .from("dealers")
          .update({ active: false, inactivated_at: new Date().toISOString() })
          .eq("id", d.id);
        if (uErr) throw new Error(`dealers update: ${uErr.message}`);
        stats.archived++;

        // 2. Archive the da-billing customer so no further invoices generate.
        //    Prefer billing_customer_id; fall back to internal_id for legacy
        //    migrated dealers. Skip with a warning if neither is set.
        const customerKey = d.billing_customer_id ?? d.internal_id;
        if (customerKey && billingConfigured()) {
          try {
            await archiveCustomer(customerKey);
            stats.billing_archived++;
          } catch (err) {
            console.error(`[cron/archive-downgraded] da-billing archive failed for ${d.dealer_id}:`, err instanceof Error ? err.message : err);
            // Don't count this as a full archive failure — DA-Platform side
            // already flipped. Surface in the summary email below.
          }
        } else if (!customerKey) {
          stats.billing_skipped_no_customer++;
          console.warn(`[cron/archive-downgraded] no billing customer key for ${d.dealer_id} — DA flipped Inactive but da-billing untouched`);
        }

        archivedSummaries.push({ dealer_id: d.dealer_id, name: d.name, downgraded_at: d.downgraded_at });
      } catch (err) {
        stats.errors++;
        console.error(`[cron/archive-downgraded] failed dealer ${d.id} (${d.dealer_id}):`, err instanceof Error ? err.message : err);
      }
    }

    console.log(`[cron/archive-downgraded] complete`, stats);

    // Operator summary email (mirrors the ChromeData / ETL crons).
    // Skips the send when nothing was archived to avoid daily empty mail.
    if (stats.archived > 0 || stats.errors > 0) {
      try {
        const rowsHtml = archivedSummaries.map(s =>
          `<tr><td style="padding:4px 10px">${s.dealer_id}</td><td style="padding:4px 10px">${s.name ?? "—"}</td><td style="padding:4px 10px">${s.downgraded_at.slice(0,10)}</td></tr>`
        ).join("");
        await sendMandrillEmail({
          subject: `[DA Platform] archive-downgraded — ${stats.archived} archived${stats.errors ? `, ${stats.errors} errors` : ""}`,
          from_email: "alerts@dealeraddendums.com",
          from_name: "DA Platform Alerts",
          to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
          html: `<p>Daily archive-downgraded cron summary.</p>
<ul>
  <li><b>Queued:</b> ${queued ?? 0}</li>
  <li><b>Processed:</b> ${stats.processed}</li>
  <li><b>Archived (DA + da-billing):</b> ${stats.archived} / ${stats.billing_archived}</li>
  <li><b>Skipped (no billing customer key):</b> ${stats.billing_skipped_no_customer}</li>
  <li><b>Errors:</b> ${stats.errors}</li>
</ul>
${archivedSummaries.length ? `<p><b>Archived dealers</b> (downgraded ≥ ${DOWNGRADED_DAYS_THRESHOLD} days):</p>
<table style="border-collapse:collapse;font-family:Roboto,sans-serif;font-size:13px">
  <thead><tr style="background:#f5f6f7"><th style="padding:4px 10px;text-align:left">dealer_id</th><th style="padding:4px 10px;text-align:left">name</th><th style="padding:4px 10px;text-align:left">downgraded_at</th></tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>` : ""}`,
        });
      } catch (err) {
        console.error("[cron/archive-downgraded] summary email failed:", err instanceof Error ? err.message : err);
      }
    }
  })();

  return NextResponse.json({ ok: true, queued: queued ?? 0, cutoff_days: DOWNGRADED_DAYS_THRESHOLD });
}
