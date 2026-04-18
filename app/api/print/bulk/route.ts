import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";

/**
 * POST /api/print/bulk
 * Logs print events for multiple vehicles.
 * Body: { vehicle_ids: number[], document_type: 'addendum'|'infosheet'|'buyer_guide', template_id?: string }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const body = await req.json() as {
    vehicle_ids?: number[];
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

  const pool = getPool();
  const placeholders = body.vehicle_ids.map(() => "?").join(",");
  const [vrows] = await pool.execute<VehicleRowPacket[]>(
    `SELECT id, DEALER_ID FROM dealer_inventory WHERE id IN (${placeholders})`,
    body.vehicle_ids
  );

  if (!vrows.length) {
    return NextResponse.json({ error: "No vehicles found" }, { status: 404 });
  }

  // TODO: verify this should use inventory_dealer_id when comparing against claims.dealer_id
  // Scope check — all vehicles must belong to the user's dealer (for dealer roles)
  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    const forbidden = vrows.some((r) => r.DEALER_ID !== claims.dealer_id);
    if (forbidden) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const inserts = vrows.map((v) => ({
    vehicle_id: v.id,
    dealer_id: v.DEALER_ID,
    document_type: docType,
    printed_by: claims.sub,
    template_id: body.template_id ?? null,
  }));

  const { data, error: err } = await admin
    .from("print_history")
    .insert(inserts)
    .select("*");

  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  return NextResponse.json({ data, count: data?.length ?? 0 });
}
