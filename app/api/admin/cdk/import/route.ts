import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { fetchCdkExtract, parseCdkVehicles, cdkCredsConfigured, type CdkVehicle } from "@/lib/cdk-api";

const INSERT_BATCH = 500;

/** Clamp helper for varchar(N) columns on dealer_vehicles. */
function clip(v: string | null | undefined, n: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}
function clampInt(v: number | null, lo: number, hi: number): number | null {
  if (v == null) return null;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
function clampYear(v: number | null): number | null {
  return v == null ? null : (v < 1900 || v > 2100 ? null : v);
}
function clampMileage(v: number | null): number {
  return v == null ? 0 : (clampInt(v, 0, 2_000_000) ?? 0);
}
function clampMsrp(v: number | null): number | null {
  return v == null ? null : (v < 0 || v > 9_999_999.99 ? null : v);
}

/**
 * POST /api/admin/cdk/import
 * Body: { dealer_id, icompany, delta_date }
 *
 * Pulls vehicles from the CDK PIP extract endpoint, maps them to
 * dealer_vehicles columns, and inserts new rows. Existing rows are
 * skipped (ON CONFLICT DO NOTHING semantics via client-side dedup).
 * super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cdkCredsConfigured()) {
    return NextResponse.json({ error: "CDK API credentials not configured" }, { status: 500 });
  }

  let body: { dealer_id?: string; icompany?: string; delta_date?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const dealerId = body.dealer_id?.trim();
  const iCompany = body.icompany?.trim();
  const deltaDate = body.delta_date?.trim();
  if (!dealerId || !iCompany || !deltaDate) {
    return NextResponse.json({ error: "dealer_id, icompany, delta_date are required" }, { status: 400 });
  }

  // ── Resolve target dealer UUID in Supabase ────────────────────────────────
  // The CDK_DEALERS.DEALER_ID (e.g. "3PA41921") maps to dealers.dealer_id or
  // dealers.inventory_dealer_id depending on how the dealer was onboarded.
  const admin = createAdminSupabaseClient();
  const { data: matched } = await admin
    .from("dealers")
    .select("id, dealer_id, inventory_dealer_id, name")
    .or(`dealer_id.eq.${dealerId},inventory_dealer_id.eq.${dealerId}`)
    .maybeSingle<{ id: string; dealer_id: string; inventory_dealer_id: string | null; name: string }>();
  if (!matched) {
    return NextResponse.json({
      success: false,
      error: `No Supabase dealer found with dealer_id or inventory_dealer_id = ${dealerId}`,
    }, { status: 404 });
  }
  const dealerTextId = matched.dealer_id;

  // ── Pull from CDK ─────────────────────────────────────────────────────────
  let vehicles: CdkVehicle[] = [];
  try {
    const { status, bodyText } = await fetchCdkExtract({ dealerId, iCompany, deltaDate });
    if (status < 200 || status >= 300) {
      return NextResponse.json({
        success: false,
        error: `CDK returned HTTP ${status}`,
        body_preview: bodyText.slice(0, 500),
      }, { status: 502 });
    }
    vehicles = parseCdkVehicles(bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }

  if (vehicles.length === 0) {
    return NextResponse.json({
      success: true,
      vehicles_found: 0,
      vehicles_imported: 0,
      vehicles_skipped: 0,
    });
  }

  // ── Dedup against existing dealer_vehicles by VIN ─────────────────────────
  const vins = Array.from(new Set(
    vehicles.map(v => (v.vin ?? "").trim().toUpperCase()).filter(Boolean),
  ));
  const existingVins = new Set<string>();
  for (let i = 0; i < vins.length; i += 500) {
    const slice = vins.slice(i, i + 500);
    const { data } = await admin
      .from("dealer_vehicles")
      .select("vin")
      .eq("dealer_id", dealerTextId)
      .in("vin", slice);
    for (const r of data ?? []) {
      if (r.vin) existingVins.add(r.vin.toUpperCase());
    }
  }

  // ── Build insert payload, applying the same clamps as the backfill ────────
  const nowIso = new Date().toISOString();
  const inserts: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const v of vehicles) {
    const vin = (v.vin ?? "").trim().toUpperCase();
    if (!vin) { skipped++; continue; }
    if (existingVins.has(vin)) { skipped++; continue; }
    const newUsedRaw = (v.new_used ?? "").trim();
    const condition = newUsedRaw.toLowerCase().startsWith("u") ? "Used" : "New";
    inserts.push({
      dealer_id: dealerTextId,
      stock_number: clip(v.stock_number, 50) ?? vin,
      vin,
      year: clampYear(v.year),
      make: clip(v.make, 50),
      model: clip(v.model, 50),
      trim: clip(v.trim, 80),
      body_style: clip(v.body_style, 50),
      exterior_color: clip(v.ext_color, 50),
      interior_color: clip(v.int_color, 50),
      mileage: clampMileage(v.mileage),
      msrp: clampMsrp(v.msrp),
      internet_price: clip(v.internet_price, 16),
      condition,
      status: "active",
      certified: clip(v.certified, 10),
      created_by: "CDK_IMPORT",
      date_added: nowIso,
      date_in_stock: clip(v.date_in_stock, 20),
      input_date: nowIso.slice(0, 10),
    });
    existingVins.add(vin); // dedupe within the batch too
  }

  // ── Bulk insert with per-row fallback for resilience ──────────────────────
  let imported = 0;
  for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
    const batch = inserts.slice(i, i + INSERT_BATCH);
    const { error: insErr } = await admin
      .from("dealer_vehicles")
      .insert(batch as never[]);
    if (insErr) {
      // Same fallback as manualVehicles ETL — one bad row shouldn't poison
      // the whole batch. Common reason here is stock_number collisions.
      for (const row of batch) {
        const { error: rowErr } = await admin.from("dealer_vehicles").insert(row as never);
        if (rowErr) {
          // Retry once with stock_number → VIN to dodge the (dealer_id,
          // stock_number) unique constraint.
          const r = row as Record<string, unknown>;
          const retry = { ...r, stock_number: r.vin };
          const { error: retry2 } = await admin.from("dealer_vehicles").insert(retry as never);
          if (!retry2) imported++;
        } else {
          imported++;
        }
      }
    } else {
      imported += batch.length;
    }
  }

  // ── Update LAST_DELTA on the CDK row so we know it was imported ───────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("cdk_dealers")
      .update({ LAST_DELTA: new Date().toISOString() })
      .eq("DEALER_ID", dealerId);
  } catch (err) {
    console.error("[cdk-import] LAST_DELTA update failed:", err instanceof Error ? err.message : err);
  }

  return NextResponse.json({
    success: true,
    vehicles_found: vehicles.length,
    vehicles_imported: imported,
    vehicles_skipped: skipped,
  });
}
