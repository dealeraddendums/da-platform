import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { fetchCdkExtract, parseCdkVehicles, cdkCredsConfigured, type CdkVehicle } from "@/lib/cdk-api";

const STATUS_KEY = "cdk_bulk_update_status";
const EXCLUSION_RE = /(test|allan)/i;

interface CdkBulkStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  delta_date: string;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_skipped: number;
  errors: Array<{ dealer_id: string; dealer_name: string; error: string }>;
}

interface CdkDealerRow {
  DEALER_ID: string | null;
  ICOMPANY: string | null;
  DEALER_NAME: string | null;
}

// ── Same clamps as the single-dealer import ─────────────────────────────────
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
 * POST /api/admin/cdk/bulk-update
 * Body: { delta_date: "YYYY-MM-DDTHH:MM:SS-0600" }
 *
 * Kicks off a sequential bulk resync across every CDK dealer (minus
 * test/allan exclusions). Returns immediately with { ok: true } — progress
 * tracked in admin_settings.cdk_bulk_update_status, polled by the UI via
 * GET /api/admin/cdk/bulk-update/status.
 *
 * Refuses to start a second concurrent job; super_admin can dismiss a
 * completed/failed run via POST /api/admin/cdk/bulk-update/status with
 * { action: "dismiss" } to reset the state.
 *
 * Background-task caveat: Next.js doesn't have first-class background
 * workers. The void Promise here keeps running as long as this PM2 worker
 * stays alive — a hot deploy / pm2 restart mid-run will leave the
 * admin_settings status in "running" forever. The status route surfaces
 * a stalled-job warning when started_at is older than 30 min with no
 * progress; super_admin can dismiss to clear.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cdkCredsConfigured()) {
    return NextResponse.json({ error: "CDK API credentials not configured" }, { status: 500 });
  }

  let body: { delta_date?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const deltaDate = body.delta_date?.trim();
  if (!deltaDate) {
    return NextResponse.json({ error: "delta_date is required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Refuse to start a second job while one is in flight.
  const { data: existing } = await admin
    .from("admin_settings")
    .select("value")
    .eq("key", STATUS_KEY)
    .maybeSingle<{ value: string }>();
  if (existing?.value) {
    try {
      const parsed = JSON.parse(existing.value) as CdkBulkStatus;
      if (parsed.status === "running") {
        return NextResponse.json({
          error: "A bulk update is already running",
          status: parsed,
        }, { status: 409 });
      }
    } catch { /* stale/corrupt — fall through and overwrite */ }
  }

  // Load dealers to process. NEW filter is intentionally omitted — bulk
  // update covers everyone. Exclude test/allan by name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dealersRaw } = await (admin as any)
    .from("cdk_dealers")
    .select("DEALER_ID, ICOMPANY, DEALER_NAME");
  const allDealers = (dealersRaw ?? []) as CdkDealerRow[];
  const dealers = allDealers.filter(d =>
    d.DEALER_ID && d.ICOMPANY && !EXCLUSION_RE.test(d.DEALER_NAME ?? ""),
  );

  const initialStatus: CdkBulkStatus = {
    status: "running",
    started_at: new Date().toISOString(),
    delta_date: deltaDate,
    total_dealers: dealers.length,
    completed: 0,
    failed: 0,
    current_dealer: null,
    total_vehicles_imported: 0,
    total_vehicles_skipped: 0,
    errors: [],
  };
  await writeStatus(initialStatus);

  // Fire-and-forget the loop. Caught at the top to avoid unhandled
  // rejections from the request-promise chain; per-dealer errors are
  // captured in status.errors.
  void runBulkUpdate(dealers, deltaDate).catch(err => {
    console.error("[cdk-bulk-update] fatal:", err);
  });

  return NextResponse.json({ ok: true, total_dealers: dealers.length, started_at: initialStatus.started_at });
}

async function runBulkUpdate(dealers: CdkDealerRow[], deltaDate: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const status: CdkBulkStatus = {
    status: "running",
    started_at: new Date().toISOString(),
    delta_date: deltaDate,
    total_dealers: dealers.length,
    completed: 0,
    failed: 0,
    current_dealer: null,
    total_vehicles_imported: 0,
    total_vehicles_skipped: 0,
    errors: [],
  };

  for (const dealer of dealers) {
    status.current_dealer = dealer.DEALER_NAME ?? dealer.DEALER_ID;
    await writeStatus(status);

    try {
      const result = await importOneDealer(admin, dealer, deltaDate);
      status.total_vehicles_imported += result.imported;
      status.total_vehicles_skipped += result.skipped;
    } catch (err) {
      status.failed++;
      status.errors.push({
        dealer_id: dealer.DEALER_ID ?? "",
        dealer_name: dealer.DEALER_NAME ?? "",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    status.completed++;
  }

  status.status = "completed";
  status.current_dealer = null;
  status.completed_at = new Date().toISOString();
  await writeStatus(status);
}

async function importOneDealer(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: CdkDealerRow,
  deltaDate: string,
): Promise<{ imported: number; skipped: number }> {
  const dealerId = dealer.DEALER_ID!;
  const iCompany = dealer.ICOMPANY!;

  const { status, bodyText } = await fetchCdkExtract({ dealerId, iCompany, deltaDate });
  if (status < 200 || status >= 300) {
    throw new Error(`CDK HTTP ${status}`);
  }
  const vehicles = parseCdkVehicles(bodyText);
  if (vehicles.length === 0) return { imported: 0, skipped: 0 };

  // Resolve the Supabase dealer UUID's text key
  const { data: matched } = await admin
    .from("dealers")
    .select("dealer_id")
    .or(`dealer_id.eq.${dealerId},inventory_dealer_id.eq.${dealerId}`)
    .maybeSingle<{ dealer_id: string }>();
  if (!matched) {
    throw new Error(`No Supabase dealer found for ${dealerId}`);
  }
  const dealerTextId = matched.dealer_id;

  // Dedup against existing dealer_vehicles by VIN
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

  const nowIso = new Date().toISOString();
  const inserts: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const v of vehicles as CdkVehicle[]) {
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
      created_by: "CDK_BULK_UPDATE",
      date_added: nowIso,
      date_in_stock: clip(v.date_in_stock, 20),
      input_date: nowIso.slice(0, 10),
    });
    existingVins.add(vin);
  }

  if (inserts.length === 0) return { imported: 0, skipped };

  let imported = 0;
  // Batch insert with per-row fallback for stock_number collisions
  const BATCH = 500;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const { error: insErr } = await admin.from("dealer_vehicles").insert(batch as never[]);
    if (insErr) {
      for (const row of batch) {
        const { error: rowErr } = await admin.from("dealer_vehicles").insert(row as never);
        if (rowErr) {
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
  return { imported, skipped };
}

async function writeStatus(status: CdkBulkStatus): Promise<void> {
  const admin = createAdminSupabaseClient();
  await admin.from("admin_settings").upsert(
    { key: STATUS_KEY, value: JSON.stringify(status), updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
}
