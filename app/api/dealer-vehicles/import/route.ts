import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleInsert, VehicleAuditLogInsert } from "@/lib/db";

type MappedVehicle = {
  stock_number: string;
  vin?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  body_style?: string | null;
  exterior_color?: string | null;
  mileage?: number;
  msrp?: number | null;
  condition?: string;
  description?: string | null;
  options?: string | null;
};

/**
 * POST /api/dealer-vehicles/import
 * Bulk upsert a pre-mapped batch of vehicles.
 * Body: { mode: 'update' | 'replace', vehicles: MappedVehicle[], deleteFirst?: boolean }
 *   mode=update: upsert (insert or update existing by stock_number)
 *   mode=replace + deleteFirst=true: delete all dealer vehicles first, then insert
 * Returns: { imported, skipped, total }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    if ((claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id) {
      return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
    }

    const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    if (!dealerId) {
      return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
    }

    let body: { mode?: string; vehicles?: unknown[]; deleteFirst?: boolean };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const mode = body.mode === "replace" ? "replace" : "update";
    const vehicles = Array.isArray(body.vehicles) ? body.vehicles : [];
    const deleteFirst = body.deleteFirst === true && mode === "replace";

    if (vehicles.length === 0) {
      return NextResponse.json({ error: "No vehicles provided" }, { status: 422 });
    }

    const admin = createAdminSupabaseClient();

    if (deleteFirst) {
      const { error: deleteErr } = await admin
        .from("dealer_vehicles")
        .delete()
        .eq("dealer_id", dealerId);

      if (deleteErr) {
        console.error("[import] delete error:", deleteErr);
        if (deleteErr.code === "42P01") {
          return NextResponse.json(
            { error: "Vehicle table not ready — please contact support" },
            { status: 503 }
          );
        }
        return NextResponse.json({ error: deleteErr.message }, { status: 500 });
      }
    }

    let skipped = 0;
    const inserts: DealerVehicleInsert[] = [];

    for (const v of vehicles) {
      const veh = v as MappedVehicle;
      const stock = (veh.stock_number ?? "").trim();
      if (!stock) { skipped++; continue; }

      inserts.push({
        dealer_id: dealerId,
        stock_number: stock,
        vin: veh.vin?.trim().toUpperCase() || null,
        year: veh.year ?? null,
        make: veh.make?.trim() || null,
        model: veh.model?.trim() || null,
        trim: veh.trim?.trim() || null,
        body_style: veh.body_style?.trim() || null,
        exterior_color: veh.exterior_color?.trim() || null,
        mileage: veh.mileage ?? 0,
        msrp: veh.msrp ?? null,
        condition: veh.condition || "New",
        status: "active",
        decode_source: "manual",
        decode_flagged: false,
        description: veh.description?.trim() || null,
        options: veh.options?.trim() || null,
        created_by: "csv_import",
      });
    }

    if (inserts.length === 0) {
      return NextResponse.json({ imported: 0, skipped, total: vehicles.length });
    }

    // Deduplicate within the batch — PostgreSQL cannot upsert the same key twice
    // in one statement. Keep the last occurrence so the most recent data wins.
    const dedupMap = new Map<string, DealerVehicleInsert>();
    for (const row of inserts) dedupMap.set(row.stock_number, row);
    const deduped = Array.from(dedupMap.values());
    skipped += inserts.length - deduped.length;

    const { data, error: upsertErr } = await admin
      .from("dealer_vehicles")
      .upsert(deduped, { onConflict: "dealer_id,stock_number", ignoreDuplicates: false })
      .select("id");

    if (upsertErr) {
      console.error("[import] upsert error:", upsertErr);
      if (upsertErr.code === "42P01") {
        return NextResponse.json(
          { error: "Vehicle table not ready — please contact support" },
          { status: 503 }
        );
      }
      return NextResponse.json({ error: upsertErr.message }, { status: 500 });
    }

    const imported = data?.length ?? 0;
    skipped += inserts.length - imported;

    // Audit log — one entry per successfully imported vehicle
    if (data?.length) {
      const idMap = new Map(deduped.map((r, i) => [r.stock_number, data[i]?.id as string | undefined]));
      const logEntries: VehicleAuditLogInsert[] = data
        .map((row, i) => ({
          dealer_id: dealerId,
          vehicle_id: row.id as string,
          stock_number: deduped[i]?.stock_number ?? null,
          action: "import" as const,
          method: "csv_import",
          changed_by: claims.sub,
          changed_by_email: claims.email,
        }))
        .filter((e) => e.vehicle_id);
      if (logEntries.length) {
        void admin.from("vehicle_audit_log").insert(logEntries);
      }
      void idMap; // suppress unused warning
    }

    return NextResponse.json({ imported, skipped, total: vehicles.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[import] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
