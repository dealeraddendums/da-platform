import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerVehicleInsert } from "@/lib/db";

/**
 * POST /api/dealer-vehicles/import
 * Bulk insert vehicles from a parsed file (client does the parsing).
 * Body: { rows: Array<Record<string, string>>, mapping: Record<string, string> }
 *   mapping keys are DA field names, values are source column headers.
 * Returns: { imported: number, skipped: number, errors: string[] }
 *
 * Restricted to dealer_admin / dealer_user only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "super_admin" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });
  }

  const dealerId = claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });
  }

  let body: { rows?: unknown[]; mapping?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows = body.rows ?? [];
  const mapping = body.mapping ?? {};

  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows provided" }, { status: 422 });
  }

  function get(row: Record<string, string>, daField: string): string {
    const col = mapping[daField];
    return col ? (row[col] ?? "").trim() : "";
  }

  const inserts: DealerVehicleInsert[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, string>;
    const stock = get(row, "Stock Number");
    if (!stock) {
      errors.push(`Row ${i + 1}: missing Stock Number — skipped`);
      continue;
    }
    const msrpRaw = get(row, "MSRP").replace(/[$,]/g, "");
    const mileageRaw = get(row, "Mileage").replace(/,/g, "");
    inserts.push({
      dealer_id: dealerId,
      stock_number: stock,
      vin: get(row, "VIN").toUpperCase() || null,
      year: get(row, "Year") ? parseInt(get(row, "Year"), 10) : null,
      make: get(row, "Make") || null,
      model: get(row, "Model") || null,
      trim: get(row, "Trim") || null,
      body_style: get(row, "Body Style") || null,
      exterior_color: get(row, "Color") || null,
      mileage: mileageRaw ? parseInt(mileageRaw, 10) : 0,
      msrp: msrpRaw ? parseFloat(msrpRaw) : null,
      condition: get(row, "Condition") || "New",
      status: "active",
      decode_source: "manual",
      decode_flagged: false,
    });
  }

  if (inserts.length === 0) {
    return NextResponse.json({ imported: 0, skipped: rows.length, errors });
  }

  const admin = createAdminSupabaseClient();
  // Upsert in batches of 100; skip duplicates (ON CONFLICT DO NOTHING)
  let imported = 0;
  let skipped = 0;
  const BATCH = 100;

  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const { data, error: dbErr } = await admin
      .from("dealer_vehicles")
      .upsert(batch, { onConflict: "dealer_id,stock_number", ignoreDuplicates: true })
      .select("id");

    if (dbErr) {
      errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${dbErr.message}`);
      skipped += batch.length;
    } else {
      imported += data?.length ?? 0;
      skipped += batch.length - (data?.length ?? 0);
    }
  }

  return NextResponse.json({ imported, skipped, errors });
}
