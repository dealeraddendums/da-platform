import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import {
  applySyncEnrichment,
  newEnrichmentContext,
  summarizeEnrichment,
  type EnrichmentReport,
  type EtlDealerEnrichment,
} from "@/lib/migration-sync-enrichment";

export const dynamic = "force-dynamic";
// Scoped syncs run full Aurora scans on the ETL box — allow a few minutes.
export const maxDuration = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EtlDealerResult = {
  inventory_dealer_id: string;
  dealer_id?: string;
  name?: string;
  status: "synced" | "refused" | "not_found";
  reason?: string;
  post?: { has_settings: boolean; options: number; logo_url_set: boolean };
  /** read-only Aurora + FreshBooks billing facts (2026-08-09 ETL build) */
  enrichment?: EtlDealerEnrichment;
};
type EtlSyncResponse = {
  ok: boolean;
  durationMs: number;
  dealers: EtlDealerResult[];
  jobs: { job: string; synced: number; failed: number; note?: string; errors: string[] }[];
};

/**
 * POST /api/migration/sync — manual Aurora → Supabase sync (2026-07-17).
 * super_admin only. Body: { dealer_ids: <dealers.id UUID>[] } (1–25).
 *
 * Replaces the old "stage" action + nightly config ETL: proxies to the ETL
 * box's scoped /sync (dealer record, group, settings, products, logo for ONLY
 * these dealers), then per successfully-synced dealer stamps
 * last_synced_at/by, promotes migration_status to 'pending' (only from
 * NULL/'legacy' — invited/migrating/migrated are never touched), and writes a
 * migration_log 'synced' row. 'pending' is what the Ready gate reads as
 * "synced/prepared".
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) {
    return NextResponse.json({ error: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured." }, { status: 503 });
  }

  let body: { dealer_ids?: string[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const dealerIds = Array.isArray(body.dealer_ids)
    ? Array.from(new Set(body.dealer_ids.filter((x) => typeof x === "string" && UUID_RE.test(x))))
    : [];
  if (dealerIds.length === 0) return NextResponse.json({ error: "dealer_ids (dealer UUIDs) required." }, { status: 400 });
  if (dealerIds.length > 25) return NextResponse.json({ error: "Max 25 dealers per sync call." }, { status: 400 });

  // migration_status / last_synced_at / migration_log aren't in the generated
  // Database types (same convention as the other /api/migration routes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminSupabaseClient() as any;
  // account_type / inventory_provider are captured PRE-sync so the enrichment
  // report can show old → new after the ETL refreshes them from Aurora.
  const { data: dealers, error: readErr } = await admin
    .from("dealers")
    .select("id, dealer_id, inventory_dealer_id, name, migration_status, account_type, inventory_provider")
    .in("id", dealerIds);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!dealers || dealers.length === 0) return NextResponse.json({ error: "No matching dealers." }, { status: 404 });

  type DealerRow = { id: string; dealer_id: string; inventory_dealer_id: string | null; migration_status: string | null; account_type: string | null; inventory_provider: string | null };
  const byInventoryId = new Map<string, DealerRow>();
  for (const d of dealers as DealerRow[]) {
    byInventoryId.set((d.inventory_dealer_id ?? d.dealer_id).trim(), d);
  }

  // Call the ETL box. The box mutexes against its nightly run and re-checks
  // migrated/etl_locked/group-locked itself — it is the authority on refusals.
  let etl: EtlSyncResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 570_000);
    const res = await fetch(`${etlUrl.replace(/\/$/, "")}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
      body: JSON.stringify({ dealer_inventory_ids: Array.from(byInventoryId.keys()) }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const msg = (json as { error?: string } | null)?.error ?? `ETL sync failed (HTTP ${res.status})`;
      return NextResponse.json({ error: msg }, { status: res.status === 409 ? 409 : 502 });
    }
    etl = json as EtlSyncResponse;
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "ETL sync timed out." : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `ETL box unreachable: ${msg}` }, { status: 502 });
  }

  // Stamp sync bookkeeping for every dealer the box actually synced.
  const syncedInvIds = etl.dealers.filter((d) => d.status === "synced").map((d) => d.inventory_dealer_id);
  const syncedUuids = syncedInvIds
    .map((inv) => byInventoryId.get(inv)?.id)
    .filter((x): x is string => !!x);
  if (syncedUuids.length > 0) {
    const nowIso = new Date().toISOString();
    const { error: stampErr } = await admin
      .from("dealers")
      .update({ last_synced_at: nowIso, last_synced_by: claims.sub })
      .in("id", syncedUuids);
    if (stampErr) console.error("[migration/sync] last_synced stamp failed:", stampErr.message);

    const { data: staged, error: stageErr } = await admin
      .from("dealers")
      .update({ migration_status: "pending" })
      .in("id", syncedUuids)
      .or("migration_status.is.null,migration_status.eq.legacy")
      .select("id");
    if (stageErr) console.error("[migration/sync] pending promote failed:", stageErr.message);

    void staged;
  }

  // Billing/config enrichment per synced dealer (2026-08-09): provider mapping,
  // subscription continuity report, da-billing contact + plan + next-invoice
  // continuity from the ETL's Aurora/FreshBooks facts. Failures here degrade
  // to per-step statuses — they never fail the sync.
  const enrichmentCtx = newEnrichmentContext();
  const reportsByInvId = new Map<string, EnrichmentReport>();
  for (const d of etl.dealers) {
    if (d.status !== "synced") continue;
    const row = byInventoryId.get(d.inventory_dealer_id);
    if (!row) continue;
    try {
      const report = await applySyncEnrichment(
        admin,
        row.id,
        { account_type: row.account_type, inventory_provider: row.inventory_provider },
        d.enrichment,
        enrichmentCtx,
      );
      reportsByInvId.set(d.inventory_dealer_id, report);
      fireWrite(admin.from("migration_log").insert({
        dealer_id: row.id,
        event: "synced",
        performed_by: claims.sub,
        notes: `manual Aurora sync via Migration Console (dealer record, settings, products, logo)\nenrichment — ${summarizeEnrichment(report)}`,
      }), "migration_log synced");
    } catch (e) {
      console.error(`[migration/sync] enrichment failed for ${d.inventory_dealer_id}:`, e instanceof Error ? e.message : e);
      fireWrite(admin.from("migration_log").insert({
        dealer_id: row.id,
        event: "synced",
        performed_by: claims.sub,
        notes: `manual Aurora sync via Migration Console (dealer record, settings, products, logo)\nenrichment failed: ${e instanceof Error ? e.message : String(e)}`,
      }), "migration_log synced");
    }
  }

  return NextResponse.json({
    ok: etl.ok,
    durationMs: etl.durationMs,
    synced_at: new Date().toISOString(),
    dealers: etl.dealers.map((d) => {
      // Strip the raw ETL facts from the browser payload (contains billing
      // linkage ids); the console gets the applied per-step report instead.
      const { enrichment, ...rest } = d;
      void enrichment;
      return { ...rest, enrichment_report: reportsByInvId.get(d.inventory_dealer_id) ?? null };
    }),
    jobs: etl.jobs,
  });
}
