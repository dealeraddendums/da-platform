import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient, fireWrite } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARTS = ["print_status", "products", "missing_prices"] as const;

/**
 * POST /api/migration/resync — re-pull 4.0 data into a MIGRATED dealer
 * (Migration Console "Re-sync from 4.0…", 2026-10-22). super_admin only.
 * Body: { dealer_id: <uuid>, parts: ("print_status"|"products"|"missing_prices")[],
 *         mode: "preview"|"apply", expected?: <counts from the preview> }
 *
 * Why it's gated: /api/migration/sync refuses migrated dealers because a full
 * sync overwrites 5.0 settings, products library, logo and dealer record with
 * 4.0 data. This route can only re-pull the three parts that are additive or
 * 4.0-owned, and only for migrated, non-native dealers:
 *   print_status    unprinted → printed only; a 5.0 Clear Print History wins
 *                   unless 4.0 printed again on a later day
 *   products        4.0-owned addendum_data rows (add / drop 4.0-deleted / fix
 *                   4.0 edits); rows 5.0 wrote and 5.0 saved options untouched
 *   missing_prices  fills msrp / internet_price only where 5.0 has none
 * It must NEVER overwrite: dealer record, group, dealer_settings,
 * addendum_library, logo, vehicle_options, prices 5.0 already has, billing,
 * or migration_status.
 *
 * The ETL box builds the plan from Aurora (read-only). Apply re-plans, refuses
 * if the counts moved since the preview, backs up deleted rows on the box, and
 * writes everything in one transaction (apply_migrated_resync, migration 185),
 * which also logs migration_log 'resynced' + the DA-CRM timeline.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  const etlUrl = process.env.ETL_SYNC_URL;
  const etlKey = process.env.ETL_SYNC_API_KEY;
  if (!etlUrl || !etlKey) {
    return NextResponse.json({ error: "ETL_SYNC_URL / ETL_SYNC_API_KEY not configured." }, { status: 503 });
  }

  let body: { dealer_id?: string; parts?: string[]; mode?: string; expected?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parts = Array.isArray(body.parts) ? Array.from(new Set(body.parts)) : [];
  if (!body.dealer_id || !UUID_RE.test(body.dealer_id)) return NextResponse.json({ error: "dealer_id (dealer UUID) required." }, { status: 400 });
  if (parts.length === 0 || parts.some((p) => !(PARTS as readonly string[]).includes(p))) {
    return NextResponse.json({ error: `parts must be one or more of ${PARTS.join(", ")}.` }, { status: 400 });
  }
  if (body.mode !== "preview" && body.mode !== "apply") return NextResponse.json({ error: "mode must be preview or apply." }, { status: 400 });
  if (body.mode === "apply" && (!body.expected || typeof body.expected !== "object")) {
    return NextResponse.json({ error: "Preview first — apply needs the previewed counts." }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminSupabaseClient() as any;
  const { data: dealer, error: readErr } = await admin
    .from("dealers").select("id, dealer_id, name, migration_status, is_native").eq("id", body.dealer_id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!dealer) return NextResponse.json({ error: "Dealer not found." }, { status: 404 });
  if (dealer.migration_status !== "migrated" || dealer.is_native) {
    return NextResponse.json({ error: "Re-sync is only for dealers migrated from 4.0 — use Sync for dealers still on 4.0." }, { status: 409 });
  }

  let json: Record<string, unknown> | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 570_000);
    const res = await fetch(`${etlUrl.replace(/\/$/, "")}/resync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": etlKey },
      body: JSON.stringify({ dealer_id: dealer.id, parts, mode: body.mode, expected: body.expected, actor_id: claims.sub }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const msg = (json as { error?: string } | null)?.error ?? `Re-sync failed (HTTP ${res.status})`;
      return NextResponse.json({ error: msg }, { status: res.status === 409 ? 409 : 502 });
    }
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "Re-sync timed out." : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `ETL box unreachable: ${msg}` }, { status: 502 });
  }

  if (body.mode === "apply") {
    fireWrite(admin.from("admin_audit").insert({
      admin_user_id: claims.sub,
      action: "migrated_dealer_resync",
      target_dealer_id: dealer.dealer_id,
      metadata: { dealer_uuid: dealer.id, parts, previewed: json.previewed ?? null, applied: json.applied ?? null },
    }), "admin_audit migrated_dealer_resync");
  }

  return NextResponse.json(json);
}
