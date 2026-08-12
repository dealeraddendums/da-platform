import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string } };

/**
 * PATCH /api/group-options/[groupId]/reorder
 * Body: { order: string[] } — group_options ids in the new display order.
 *
 * Persists sort_order = index*10 (same convention as the dealer library's
 * /api/addendum-library/reorder). This order is AUTHORITATIVE at print time:
 * getGroupOptionsForDealer reads `.order("sort_order")` and the pdf/options
 * merges prepend corporate products in that sequence, so a reorder here
 * reflects on every member dealer's next print with no reassignment.
 *
 * Authz mirrors the group-options CRUD: super_admin any group, group_admin
 * their own group.
 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const canManage =
    claims.role === "super_admin" ||
    (claims.role === "group_admin" && claims.group_id === params.groupId);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { order?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const order = (body.order ?? []).filter((x) => typeof x === "string" && x.length > 0);
  if (order.length === 0) return NextResponse.json({ error: "order array required" }, { status: 400 });
  if (order.length > 500) return NextResponse.json({ error: "order too large" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  await Promise.all(
    order.map((id, idx) =>
      admin
        .from("group_options")
        .update({ sort_order: idx * 10 })
        .eq("id", id)
        .eq("group_id", params.groupId),
    ),
  );

  return NextResponse.json({ success: true });
}
