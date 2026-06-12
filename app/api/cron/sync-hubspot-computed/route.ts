// EasyCron registration (must be added manually after deploy):
//   Schedule: 0 8 * * *    (daily, 08:00 UTC = 04:00 ET — before business)
//   URL:      POST https://app.dealeraddendums.com/api/cron/sync-hubspot-computed
//   Header:   x-cron-secret: <CRON_SECRET value from .env.production>

import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import {
  hubspotConfigured,
  upsertObject,
  LIFECYCLE,
  isPayingAccount,
} from "@/lib/hubspot";
import { isOverAllowance, isFreeAccountType } from "@/lib/print-eligibility";
import { printedVehicleCount } from "@/lib/print-counts";

/**
 * POST /api/cron/sync-hubspot-computed
 *
 * Daily refresh of the HubSpot Company fields that are too expensive or
 * too event-less to push from the request path:
 *   • prints_last_30        DISTINCT vehicles from print_history over a
 *                           rolling 30 days (computed fresh — dealers.last30
 *                           is refreshed from this too, so the dealers-list
 *                           UI and event-driven syncs stay correct; the old
 *                           stored counter stopped updating after the
 *                           multiprint record-on-send refactor)
 *   • prints_last_12mo      COUNT(print_history) for the dealer over 12mo
 *   • dealers_in_group      COUNT(dealers) for each group's Company
 *   • lifecyclestage        re-evaluate Trial → Trial Expired when the
 *                           dealer is past 30 days OR 30 prints since
 *                           dealer.created_at (the trial-start proxy —
 *                           first_login_at doesn't exist on any table).
 *
 * Auth: `x-cron-secret` header must match CRON_SECRET. The route also
 * accepts a super_admin session so it can be hand-triggered from the
 * Reports page if we ever wire a button.
 *
 * Walks every dealer/group with a `hubspot_*_id` set (so a sync error
 * for a fresh signup doesn't block the cron). HubSpot CRM's standard
 * rate limit is 100 req/10s; we space PATCHes ~30/s to stay well below.
 */

const PROD_PATCH_RATE_MS = 35;          // ≈ 28 req/s
// Trial cap constants live in lib/print-eligibility.ts now; this cron uses
// isOverAllowance() so the gate, the event-driven sync, and this nightly
// re-evaluation can never disagree about who's expired.

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hubspotConfigured()) {
    return NextResponse.json({ error: "HubSpot not configured" }, { status: 503 });
  }

  // Count what's queued so EasyCron sees a meaningful response, then
  // fire-and-forget the actual loop. The walk takes ~10–20 minutes for
  // ~2.2k dealers + 214 groups; ALB (and EasyCron) cap at 60s and 504
  // the request otherwise. Same pattern as /api/cron/sync-xps-tracking.
  // PM2 keeps the Node process alive past the HTTP response so the
  // background promise can complete.
  const admin = createAdminSupabaseClient();

  const { count: dQueued } = await admin
    .from("dealers")
    .select("id", { count: "exact", head: true })
    .not("hubspot_company_id", "is", null)
    .eq("active", true);
  const { count: gQueued } = await admin
    .from("groups")
    .select("id", { count: "exact", head: true })
    .not("hubspot_company_id", "is", null);

  console.log(`[cron/sync-hubspot-computed] queued: dealers=${dQueued} groups=${gQueued} — running in background`);

  void (async () => {
    const stats = {
      dealers_processed: 0,
      dealers_updated: 0,
      dealers_expired: 0,
      groups_processed: 0,
      groups_updated: 0,
      errors: 0,
    };

    // ── Dealers ──────────────────────────────────────────────────────────
    // `as any` because Supabase types don't know about downgraded_at yet
    // (migration 083). Runtime is fine; only TS is stale.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealers } = await (admin as any)
      .from("dealers")
      .select("id, dealer_id, account_type, created_at, last30, hubspot_company_id, group_id, downgraded_at")
      .not("hubspot_company_id", "is", null)
      .eq("active", true) as { data: Array<{ id: string; dealer_id: string; account_type: string | null; created_at: string | null; last30: number | null; hubspot_company_id: string; group_id: string | null; downgraded_at: string | null }> | null };

    const twelveMonthsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo   = new Date(Date.now() -  30 * 24 * 60 * 60 * 1000).toISOString();

    for (const d of dealers ?? []) {
      stats.dealers_processed++;
      try {
        // DISTINCT vehicles printed in the window, not print_history rows —
        // same semantics as the trial cap (multiprint-qa-2026-06-11 Issue B).
        const prints12 = await printedVehicleCount(admin, { dealerId: d.dealer_id, since: twelveMonthsAgo });
        const prints30 = await printedVehicleCount(admin, { dealerId: d.dealer_id, since: thirtyDaysAgo });

        // Keep dealers.last30 in step with the same computation — it feeds
        // the dealers-list UI and the event-driven HubSpot pushes between
        // cron runs.
        if ((d.last30 ?? 0) !== prints30) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (admin as any).from("dealers").update({ last30: prints30 }).eq("id", d.id);
        }

        // Lifecycle precedence mirrors lib/sync-hubspot.ts dealerCompanyProperties
        // (and the docs/print-eligibility-free-expired.md spec). Free is
        // bucketed alongside downgraded_at; isOverAllowance shared with the
        // server-side canPrint gate.
        let stage: string | null = null;
        if (isPayingAccount(d.account_type)) {
          stage = LIFECYCLE.CUSTOMER;
        } else if (d.downgraded_at || isFreeAccountType(d.account_type)) {
          stage = LIFECYCLE.ACCOUNT_DOWNGRADED;
        } else {
          const lifetimePrints = await printedVehicleCount(admin, { dealerId: d.dealer_id });
          const expired = isOverAllowance({ created_at: d.created_at, lifetime_prints: lifetimePrints });
          stage = expired ? LIFECYCLE.TRIAL_EXPIRED : LIFECYCLE.DEALER_TRIAL;
          if (expired) stats.dealers_expired++;
        }

        await upsertObject({
          object: "companies",
          properties: {
            prints_last_30:   prints30 ?? 0,
            prints_last_12mo: prints12 ?? 0,
            lifecyclestage:   stage,
          },
          existingHubspotId: d.hubspot_company_id,
          searchProperty: "platformid",
          searchValue: d.dealer_id,
        });
        stats.dealers_updated++;
        if (stats.dealers_updated % 500 === 0) {
          console.log(`[cron/sync-hubspot-computed] progress: dealers ${stats.dealers_updated}/${dealers?.length ?? 0}`);
        }
        await new Promise(r => setTimeout(r, PROD_PATCH_RATE_MS));
      } catch (err) {
        stats.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cron/sync-hubspot-computed] dealer ${d.id} failed:`, message);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("hubspot_sync_errors").insert({
          object_type: "company",
          object_id: d.id,
          hubspot_id: d.hubspot_company_id,
          op: "update",
          error_message: message,
          payload: { source: "cron/sync-hubspot-computed/dealer" },
        }).then(() => {}).catch(() => {});
      }
    }

    // ── Groups ───────────────────────────────────────────────────────────
    const { data: groups } = await admin
      .from("groups")
      .select("id, hubspot_company_id")
      .not("hubspot_company_id", "is", null);

    for (const g of groups ?? []) {
      stats.groups_processed++;
      try {
        const { count: memberCount } = await admin
          .from("dealers")
          .select("id", { count: "exact", head: true })
          .eq("group_id", g.id)
          .eq("active", true);

        await upsertObject({
          object: "companies",
          properties: { dealers_in_group: memberCount ?? 0 },
          existingHubspotId: g.hubspot_company_id,
          searchProperty: "groupid",
          searchValue: null,
        });
        stats.groups_updated++;
        await new Promise(r => setTimeout(r, PROD_PATCH_RATE_MS));
      } catch (err) {
        stats.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cron/sync-hubspot-computed] group ${g.id} failed:`, message);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("hubspot_sync_errors").insert({
          object_type: "company",
          object_id: g.id,
          hubspot_id: g.hubspot_company_id,
          op: "update",
          error_message: message,
          payload: { source: "cron/sync-hubspot-computed/group" },
        }).then(() => {}).catch(() => {});
      }
    }

    console.log(`[cron/sync-hubspot-computed] complete`, stats);
  })();

  return NextResponse.json({ ok: true, queued: { dealers: dQueued, groups: gQueued } });
}
