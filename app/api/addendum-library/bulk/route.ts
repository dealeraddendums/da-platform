import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * DELETE /api/addendum-library/bulk
 * Body: { ids: string[] } — deletes up to 200 library rows in one call.
 * Same ownership rules as DELETE /api/addendum-library/[id]: dealer roles and
 * a group_admin acting as a dealer may only delete their own dealer's rows.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids required" }, { status: 400 });
  }
  if (ids.length > 200) {
    return NextResponse.json({ error: "Too many ids (max 200)" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: existing, error: selErr } = await admin
    .from("addendum_library")
    .select("id, dealer_id")
    .in("id", ids);
  if (selErr) {
    return NextResponse.json({ error: selErr.message }, { status: 500 });
  }
  if (!existing || existing.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // dealer roles and a group_admin acting as a dealer may only touch their own
  // dealer's rows. group_admin without an active dealer has a null dealer_id,
  // so this rejects them too.
  if (
    (claims.role === "dealer_admin" || claims.role === "dealer_user" || claims.role === "group_admin") &&
    existing.some((r) => r.dealer_id !== claims.dealer_id)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (
    claims.role !== "dealer_admin" && claims.role !== "dealer_user" &&
    claims.role !== "group_admin" && claims.role !== "super_admin"
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const foundIds = existing.map((r) => r.id as string);
  const { error: dbError } = await admin
    .from("addendum_library")
    .delete()
    .in("id", foundIds);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, deleted: foundIds.length });
}
