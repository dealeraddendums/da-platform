// The print-recording pipeline, decoupled from PDF generation.
//
// Previously each PDF route ran its own fire-and-forget logging at GENERATION
// time (print_history + dealer_vehicles flags + audit + addendum_data), so a
// preview that was cancelled still counted as a print. Now the routes stash a
// PrintRecordPayload in pending_prints (migration 099) and hand the client a
// one-time token; POST /api/print/confirm claims the token on the actual
// Send-to-Printer / Download action and calls recordPrint() here.
//
// recordPrint() preserves each source's original side-effect set exactly:
//   generate    → print_history, dealer_vehicles flags, vehicle_audit_log,
//                 addendum_data snapshot, save-state sync (addendum only),
//                 addendum_history
//   bulk        → print_history, dealer_vehicles flags, addendum_data snapshot,
//                 save-state sync (addendum only)
//   buyer_guide → print_history only
// (bulk never audit-logged and single buyer-guide never flipped print_guide —
// parity kept so this change is purely WHEN, not WHAT, gets recorded.)

import type { createAdminSupabaseClient } from "@/lib/db";
import type { AddendumDataInsert, AddendumHistoryInsert, VehicleAuditLogInsert } from "@/lib/db";
import { signPdfKey } from "@/lib/s3-upload";
import { syncAddendumItems } from "@/lib/sync-addendum-items";
import { persistPrintedOptions, type SaveOption } from "@/lib/vehicle-options-save";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

export type PrintDocType = "addendum" | "infosheet" | "buyer_guide";

export interface PrintRecordOption {
  option_name: string;
  option_price?: string;
  description?: string | null;
  required?: boolean;
}

export interface PrintRecordPayload {
  source: "generate" | "bulk" | "buyer_guide";
  vehicleId: string;            // dealer_vehicles UUID
  dealerTextId: string;         // dealers.dealer_id — print_history/audit dealer key
  dealerUuid: string | null;    // dealers.id — addendum_data dealer key
  vin: string | null;
  stockNumber: string | null;
  docType: PrintDocType;
  s3Key: string | null;
  /** Pre-signed URL when the PDF service already returned one (bulk service
   *  path); otherwise recordPrint signs s3Key itself. */
  pdfUrl?: string | null;
  options: PrintRecordOption[];
  /** Save-on-print: the NON-group effective set the PDF rendered (saved-
   *  surviving + newly-added + library-seed matches), to persist into
   *  vehicle_options at confirm. Group options are excluded — they're group-
   *  owned and merge at read time; persisting them would duplicate on every
   *  read. Absent for buyer_guide / when there's nothing to persist. */
  saveOptions?: SaveOption[];
}

/**
 * Stash payloads for a later confirm. Returns the one-time token, or null if
 * the insert failed (e.g. migration 099 not applied yet) — callers fall back
 * to recording immediately, i.e. the legacy generation-time behavior.
 */
export async function createPendingPrint(
  admin: Admin,
  args: { dealerTextId: string; createdBy: string; payloads: PrintRecordPayload[] },
): Promise<string | null> {
  const { data, error } = await admin
    .from("pending_prints")
    .insert({ dealer_id: args.dealerTextId, created_by: args.createdBy, payload: args.payloads })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[record-print] pending_prints insert failed (falling back to immediate logging):", error?.message);
    return null;
  }
  return data.id as string;
}

/** Run the full recording pipeline for one printed vehicle. */
export async function recordPrint(admin: Admin, printedBy: string, p: PrintRecordPayload): Promise<void> {
  let pdfUrl = p.pdfUrl ?? "";
  if (!pdfUrl && p.s3Key) {
    try {
      pdfUrl = await signPdfKey(p.s3Key);
    } catch (err) {
      console.error("[record-print] signPdfKey failed:", err instanceof Error ? err.message : err);
    }
  }

  const { error: phErr } = await admin.from("print_history").insert({
    vehicle_id: p.vehicleId,
    dealer_id: p.dealerTextId,
    document_type: p.docType,
    printed_by: printedBy,
    pdf_url: pdfUrl || null,
  });
  if (phErr) console.error("[record-print] print_history insert failed:", phErr.message, phErr.code);

  // Canonical print flags on dealer_vehicles — dashboard counts, filters, and
  // the per-document button states read these. Doc type controls the column:
  // addendum → print_status, infosheet → print_info, buyer_guide → print_guide.
  // (Single buyer-guide prints never flipped flags — parity preserved.)
  if (p.source !== "buyer_guide") {
    const todayDate = new Date().toISOString().split("T")[0];
    const dvUpdate: Partial<{ print_status: number; print_info: number; print_guide: number; print_date: string; print_user: string; print_queue: number; print_queue_at: string | null; print_queue_by: string | null }> = {
      print_date: todayDate,
      print_user: printedBy,
    };
    if (p.docType === "addendum") {
      dvUpdate.print_status = 1;
      // Any successful addendum print (web single, web bulk, mobile) dequeues
      // the vehicle from the mobile print queue (IOS-APP-SPEC §8.3).
      dvUpdate.print_queue = 0;
      dvUpdate.print_queue_at = null;
      dvUpdate.print_queue_by = null;
    }
    else if (p.docType === "infosheet") dvUpdate.print_info = 1;
    else if (p.docType === "buyer_guide") dvUpdate.print_guide = 1;
    let { error: dvUpdateErr } = await admin
      .from("dealer_vehicles")
      .update(dvUpdate)
      .eq("id", p.vehicleId);
    // Pre-migration-123 safety net: print_queue_at/print_queue_by don't exist
    // until migration 123 is applied. Retry without the queue fields so the
    // canonical flags still flip.
    if (dvUpdateErr && /print_queue|schema cache|does not exist/i.test(dvUpdateErr.message)) {
      const { print_queue: _q, print_queue_at: _qa, print_queue_by: _qb, ...withoutQueue } = dvUpdate;
      void _q; void _qa; void _qb;
      const retry = await admin.from("dealer_vehicles").update(withoutQueue).eq("id", p.vehicleId);
      dvUpdateErr = retry.error;
    }
    // Pre-migration-055 safety net: print_user was varchar(20) and rejected
    // 36-char UUIDs, rolling back the whole UPDATE. Retry without print_user
    // so the canonical flags still flip.
    if (dvUpdateErr && /too long/i.test(dvUpdateErr.message)) {
      const { print_user: _omit, ...withoutUser } = dvUpdate;
      void _omit;
      const retry = await admin.from("dealer_vehicles").update(withoutUser).eq("id", p.vehicleId);
      dvUpdateErr = retry.error;
    }
    if (dvUpdateErr) console.error("[record-print] dealer_vehicles print update failed:", dvUpdateErr.message);
  }

  if (p.source === "generate") {
    await admin.from("vehicle_audit_log").insert({
      dealer_id: p.dealerTextId,
      vehicle_id: p.vehicleId,
      stock_number: p.stockNumber,
      action: "print",
      method: "print",
      changed_by: printedBy,
      document_type: p.docType,
    } as VehicleAuditLogInsert);
  }

  // Printed-items snapshot (the per-print addendum_data rows with printed_at +
  // s3_key, independent of the save-state slice).
  if (p.source !== "buyer_guide" && p.dealerUuid && p.options.length > 0) {
    const printedAt = new Date().toISOString();
    const adRows: AddendumDataInsert[] = p.options.map((o, i) => ({
      dealer_id: p.dealerUuid!,
      legacy_dealer_id: p.dealerTextId,
      vehicle_id: p.vehicleId,
      vin_number: p.vin,
      item_name: o.option_name,
      item_description: o.description ?? null,
      item_price: o.option_price ?? null,
      active: "1",
      or_or_ad: 1,
      order_by: i,
      separator_spaces: 2,
      editable: 1,
      printed_at: printedAt,
      document_type: p.docType,
      s3_key: p.s3Key,
      required: o.required !== false,
    }));
    const { error: adErr } = await admin.from("addendum_data").insert(adRows);
    if (adErr) console.error("[record-print] addendum_data insert failed:", adErr.message);
  }

  // Refresh the save-state slice of addendum_data with what was just printed
  // (single AND bulk paths did this). Only the addendum doc type contributes
  // the dealer's "current product set" — infosheet/buyer-guide prints aren't
  // product-set events.
  if (p.source !== "buyer_guide" && p.docType === "addendum" && p.dealerUuid) {
    await syncAddendumItems(admin, {
      vehicleId: p.vehicleId,
      dealerId: p.dealerUuid,
      legacyDealerId: p.dealerTextId,
      vin: p.vin,
      documentType: "addendum",
      products: p.options.map(o => ({
        name: o.option_name,
        price: o.option_price,
        description: o.description ?? null,
        required: o.required !== false,
      })),
    });
  }

  // Save-on-print: persist the rendered non-group option set into vehicle_options
  // so a printed vehicle becomes a saved snapshot (web ⇄ mobile parity; the feed
  // then finds its products). Guarded to SKIP legacy addendum_data vehicles and
  // unchanged sets (idempotent) — see lib/vehicle-options-save.ts. Uses the
  // vehicle's dealer context (p.dealerTextId), not the actor's, so ghost/
  // impersonation/mobile-Bearer confirms all write to the right dealer.
  if (p.source !== "buyer_guide" && p.docType === "addendum" && p.saveOptions && p.saveOptions.length > 0) {
    const outcome = await persistPrintedOptions(admin, {
      vehicleId: p.vehicleId,
      dealerTextId: p.dealerTextId,
      options: p.saveOptions,
    });
    if (outcome === "persisted") {
      console.log(`[record-print] save-on-print persisted ${p.saveOptions.length} option(s) for vehicle ${p.vehicleId}`);
    }
  }

  if (p.source === "generate") {
    const today = new Date().toISOString().split("T")[0];
    const historyRows: AddendumHistoryInsert[] = p.options.map((o, i) => ({
      legacy_id: null,
      vehicle_id: null,
      vin: p.vin,
      dealer_id: p.dealerTextId,
      item_name: o.option_name,
      item_description: null,
      item_price: o.option_price ?? null,
      active: "Yes",
      creation_date: today,
      order_by: i,
      source: "platform",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    if (historyRows.length > 0) {
      await admin.from("addendum_history").insert(historyRows);
    }
  }
}
