import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

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

  // Authorize every distinct dealer represented in the selection against the
  // caller (dealer roles → own; group_admin → in-group; group_user → in-group +
  // tag scope; super_admin → any). Any unauthorized dealer fails the whole call.
  const distinctDealerIds = Array.from(new Set(existing.map((r) => r.dealer_id as string)));
  for (const did of distinctDealerIds) {
    const authz = await authorizeDealerAction(claims, did);
    if (!authz.ok) return authz.response;
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
