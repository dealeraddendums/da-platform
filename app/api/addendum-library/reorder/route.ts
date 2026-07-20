import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

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

  // Authorize the target dealer (client sends the active dealer's id), falling
  // back to the caller's effective dealer. Group-membership / tag-scope aware.
  const authz = await authorizeDealerAction(claims, body.dealer_id ?? claims.dealer_id);
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;

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
