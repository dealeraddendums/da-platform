// Distinct-vehicle print counts — the one place that knows "prints" means
// VEHICLES, not print_history rows. A row is logged per vehicle per PDF
// generation (every preview-modal open), so raw row counts inflate on every
// reprint; a trial dealer who reprinted a 15-vehicle batch logged ~36 rows and
// was wrongly blocked by the 30-print cap. Spec: docs/multiprint-qa-2026-06-11.md.
//
// Every print counter (trial cap, billing trial progress, HubSpot
// prints_last_30/12mo, super_admin/group "addendums this month") goes through
// printedVehicleCount(). print_history keeps logging every event — the
// per-vehicle History feature relies on that — only the counts changed.

import type { createAdminSupabaseClient } from "@/lib/db";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export interface PrintedVehicleCountOpts {
  /** Single dealer (text dealer_id). */
  dealerId?: string;
  /** A set of dealers (group cards). Ignored when dealerId is set. */
  dealerIds?: string[];
  /** ISO timestamp window start; omit for lifetime. */
  since?: string;
  /** Restrict to one document type (e.g. "addendum"). The 4.0 platform's
   *  LAST30 counts ADDENDUM prints only (buyer guide/infosheet live in
   *  separate flags there), so surfaces comparing 5.0-vs-4.0 activity pass
   *  "addendum" to count apples-to-apples. Omit = all doc types (trial cap /
   *  HubSpot policy unchanged). Uses the select path (the RPC has no
   *  doc-type parameter). */
  docType?: "addendum" | "infosheet" | "buyer_guide";
}

/**
 * count(DISTINCT vehicle_id) over print_history, via the printed_vehicle_count
 * SQL function (migration 098). No filters = platform-wide.
 *
 * Falls back to a select + JS dedupe if the RPC isn't available (DDL not yet
 * applied / transient error) so callers — including the print gate — never
 * hard-fail. The fallback caps at 50k rows, which covers any single dealer;
 * only the platform-wide super_admin card could exceed it, transiently.
 */
export async function printedVehicleCount(
  admin: Admin,
  opts: PrintedVehicleCountOpts = {},
): Promise<number> {
  const { dealerId, dealerIds, since, docType } = opts;

  if (docType) return distinctVehicleSelect(admin, { dealerId, dealerIds, since, docType });

  const { data, error } = await admin.rpc("printed_vehicle_count", {
    p_dealer_id: dealerId ?? null,
    p_dealer_ids: dealerId ? null : dealerIds ?? null,
    p_since: since ?? null,
  });
  if (!error && typeof data === "number") return data;
  console.error("[print-counts] rpc printed_vehicle_count failed, using fallback:", error?.message);
  return distinctVehicleSelect(admin, { dealerId, dealerIds, since });
}

async function distinctVehicleSelect(
  admin: Admin,
  { dealerId, dealerIds, since, docType }: PrintedVehicleCountOpts,
): Promise<number> {
  let q = admin.from("print_history").select("vehicle_id").limit(50000);
  if (dealerId) q = q.eq("dealer_id", dealerId);
  else if (dealerIds) q = q.in("dealer_id", dealerIds);
  if (since) q = q.gte("created_at", since);
  if (docType) q = q.eq("document_type", docType);
  const { data: rows } = await q;
  const seen = new Set<string>();
  for (const r of rows ?? []) if (r.vehicle_id) seen.add(r.vehicle_id as string);
  return seen.size;
}
