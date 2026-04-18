import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/** GET /api/dealer-vehicles/[id]/history — audit log for a manual vehicle */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const isAdmin = (claims.role === "super_admin" || claims.role === "group_admin") && !claims.impersonating_dealer_id;
  if (isAdmin) return NextResponse.json({ error: "Not available for admin roles" }, { status: 403 });

  const dealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
  if (!dealerId) return NextResponse.json({ error: "No dealer assigned" }, { status: 403 });

  const admin = createAdminSupabaseClient();

  const { data, error: dbErr } = await admin
    .from("vehicle_audit_log")
    .select("*")
    .eq("vehicle_id", params.id)
    .eq("dealer_id", dealerId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
