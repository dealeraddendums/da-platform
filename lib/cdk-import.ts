// Shared insert path for the CDK Dealers "Import" button and the bulk "CDK Update".
// Server-only. The scheduled CDK feed lives on ETL2 (jobs 9/10); this is the
// manual path, and it must leave rows ETL2 can keep maintaining:
//
//  - stock_number comes from CDK <StockNo>. It used to fall back to the VIN
//    (the old code never read StockNo), and ETL2 — which only reconciles rows
//    it owns, matched by dealer+VIN — then inserted a second copy of every car
//    under its real stock number. Rows are written as created_by 'automatic9'
//    so ETL2 adopts them instead of twinning them.
//  - CDK <Status>G</Status> = sold; never inserted.
//  - The shared CDK id 3PA0003717 carries several Rick Case stores; each car is
//    routed by the first letter of its stock number, mirroring ETL2's
//    cdk_process.rb. A car that routes to no Supabase dealer is counted and
//    skipped — it never fails the rest of the import.

import type { createAdminSupabaseClient } from "@/lib/db";
import type { CdkVehicle } from "@/lib/cdk-api";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/** created_by ETL2 reconciles (db_retrieve.rb retrieveFromDBByDealerID). */
export const CDK_CREATED_BY = "automatic9";

const SHARED_RICK_CASE_ID = "3PA0003717";
const RICK_CASE_STOCK_PREFIXES = new Set(["Y", "G", "M", "R", "S", "A", "K"]);
const INSERT_BATCH = 500;

function clip(v: string | null | undefined, n: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n) : s;
}
function clampYear(v: number | null): number | null {
  return v == null ? null : (v < 1900 || v > 2100 ? null : v);
}
function clampMileage(v: number | null): number {
  if (v == null) return 0;
  return Math.min(Math.max(v, 0), 2_000_000);
}
function clampMsrp(v: number | null): number | null {
  return v == null ? null : (v < 0 || v > 9_999_999.99 ? null : v);
}

/** The feed dealer id a CDK vehicle belongs to (before Supabase resolution). */
export function cdkFeedDealerId(cdkDealerId: string, stockNumber: string | null): string {
  const first = (stockNumber ?? "").trim().charAt(0).toUpperCase();
  if (cdkDealerId === SHARED_RICK_CASE_ID && RICK_CASE_STOCK_PREFIXES.has(first)) {
    return `${cdkDealerId}-${first}`;
  }
  return cdkDealerId;
}

export interface CdkImportResult {
  imported: number;
  /** already on file (by VIN), or no VIN */
  skipped: number;
  /** CDK Status G */
  sold: number;
  /** no Supabase dealer for the car's feed id */
  unrouted: number;
  unroutedIds: string[];
}

export async function importCdkVehicles(
  admin: Admin,
  cdkDealerId: string,
  vehicles: CdkVehicle[],
): Promise<CdkImportResult> {
  const result: CdkImportResult = { imported: 0, skipped: 0, sold: 0, unrouted: 0, unroutedIds: [] };

  // Resolve each distinct feed id once.
  const live = vehicles.filter((v) => (v.status ?? "").trim().toUpperCase() !== "G");
  result.sold = vehicles.length - live.length;
  const feedIds = Array.from(new Set(live.map((v) => cdkFeedDealerId(cdkDealerId, v.stock_number))));
  const resolved = new Map<string, string>();
  for (const id of feedIds) {
    const { data } = await admin
      .from("dealers")
      .select("dealer_id")
      .or(`dealer_id.eq."${id}",inventory_dealer_id.eq."${id}"`)
      .limit(1)
      .maybeSingle<{ dealer_id: string }>();
    if (data?.dealer_id) resolved.set(id, data.dealer_id);
  }
  result.unroutedIds = feedIds.filter((id) => !resolved.has(id));

  // Group by target dealer, dedupe by VIN against everything already on file.
  const byDealer = new Map<string, CdkVehicle[]>();
  for (const v of live) {
    const target = resolved.get(cdkFeedDealerId(cdkDealerId, v.stock_number));
    if (!target) { result.unrouted++; continue; }
    const list = byDealer.get(target) ?? [];
    list.push(v);
    byDealer.set(target, list);
  }

  const nowIso = new Date().toISOString();
  for (const [dealerTextId, list] of Array.from(byDealer.entries())) {
    const vins = Array.from(new Set(list.map((v) => (v.vin ?? "").trim().toUpperCase()).filter(Boolean)));
    const existing = new Set<string>();
    for (let i = 0; i < vins.length; i += 500) {
      const { data } = await admin
        .from("dealer_vehicles")
        .select("vin")
        .eq("dealer_id", dealerTextId)
        .in("vin", vins.slice(i, i + 500));
      for (const r of data ?? []) if (r.vin) existing.add(r.vin.toUpperCase());
    }

    const inserts: Array<Record<string, unknown>> = [];
    for (const v of list) {
      const vin = (v.vin ?? "").trim().toUpperCase();
      if (!vin || existing.has(vin)) { result.skipped++; continue; }
      existing.add(vin);
      const condition = (v.new_used ?? "").trim().toLowerCase().startsWith("u") ? "Used" : "New";
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
        created_by: CDK_CREATED_BY,
        date_added: nowIso,
        date_in_stock: clip(v.date_in_stock, 20),
        input_date: nowIso.slice(0, 10),
      });
    }

    for (let i = 0; i < inserts.length; i += INSERT_BATCH) {
      const batch = inserts.slice(i, i + INSERT_BATCH);
      const { error: insErr } = await admin.from("dealer_vehicles").insert(batch as never[]);
      if (!insErr) { result.imported += batch.length; continue; }
      // One bad row (usually a (dealer_id, stock_number) collision with a stale
      // car) shouldn't sink the batch: retry singly, then with stock = VIN.
      for (const row of batch) {
        const { error: rowErr } = await admin.from("dealer_vehicles").insert(row as never);
        if (!rowErr) { result.imported++; continue; }
        const { error: retryErr } = await admin
          .from("dealer_vehicles")
          .insert({ ...row, stock_number: row.vin } as never);
        if (!retryErr) result.imported++;
      }
    }
  }
  return result;
}
