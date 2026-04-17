import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * PATCH /api/addendum-library/reorder
 * Body: { dealer_id: string; order: string[] }  — array of ids in new order
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { dealer_id?: string; order: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.order?.length) {
    return NextResponse.json({ error: "order array required" }, { status: 400 });
  }

  const dealerId = body.dealer_id ?? claims.dealer_id;
  if (!dealerId) {
    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  }
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user") &&
    dealerId !== claims.dealer_id
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  await Promise.all(
    body.order.map((id, idx) =>
      admin
        .from("addendum_library")
        .update({ sort_order: idx * 10 })
        .eq("id", id)
        .eq("dealer_id", dealerId)
    )
  );

  return NextResponse.json({ success: true });
}
