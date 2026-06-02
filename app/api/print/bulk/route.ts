import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { enforceCanPrint } from "@/lib/print-eligibility";

/**
 * POST /api/print/bulk
 * Logs print events for multiple dealer_vehicles.
 * Body: { vehicle_ids: string[], document_type: 'addendum'|'infosheet'|'buyer_guide', template_id?: string }
 * vehicle_ids are dealer_vehicles UUIDs.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const body = await req.json() as {
    vehicle_ids?: string[];
    document_type?: string;
    template_id?: string;
  };

  if (!body.vehicle_ids || !Array.isArray(body.vehicle_ids) || body.vehicle_ids.length === 0) {
    return NextResponse.json({ error: "vehicle_ids array required" }, { status: 400 });
  }

  const docType = body.document_type as "addendum" | "infosheet" | "buyer_guide";
  if (!["addendum", "infosheet", "buyer_guide"].includes(docType)) {
    return NextResponse.json({ error: "Invalid document_type" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Look up vehicles from dealer_vehicles
  const { data: dvRows, error: dvErr } = await admin
    .from("dealer_vehicles")
    .select("id, dealer_id")
    .in("id", body.vehicle_ids);

  if (dvErr || !dvRows?.length) {
    return NextResponse.json({ error: "No vehicles found" }, { status: 404 });
  }

  // Scope check — all vehicles must belong to the user's dealer
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    const forbidden = dvRows.some((r) => r.dealer_id !== claims.dealer_id);
    if (forbidden) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Print-eligibility gate (super_admin bypasses). For dealer_admin /
  // dealer_user the scope-check above guarantees all vehicles share one
  // dealer slug — first row is representative.
  const blocked = await enforceCanPrint(dvRows[0].dealer_id, claims);
  if (blocked) return blocked;

  const inserts = dvRows.map((v) => ({
    vehicle_id:    v.id,
    dealer_id:     v.dealer_id,
    document_type: docType,
    printed_by:    claims.sub,
    template_id:   body.template_id ?? null,
  }));

  const { data, error: err } = await admin
    .from("print_history")
    .insert(inserts)
    .select("*");

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data, count: data?.length ?? 0 });
}
