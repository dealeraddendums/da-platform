import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerRow } from "@/lib/db";

type Params = { params: { id: string; dealerId: string } };

/**
 * PATCH /api/groups/[id]/dealers/[dealerId]
 * Body: { group_controls_templates?: boolean }
 *
 * Per-dealer flag toggle. `dealerId` is the dealers.id UUID. The dealer
 * must already belong to this group (params.id) — we don't accept
 * group-reassignment through this route. super_admin can touch any
 * group; group_admin only their own.
 */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (claims.role === "group_admin" && params.id !== claims.group_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { group_controls_templates?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Whitelist patchable fields. Only group_controls_templates for now —
  // adding more later means extending this Pick<>.
  const patch: Partial<Pick<DealerRow, "group_controls_templates">> = {};
  if (typeof body.group_controls_templates === "boolean") {
    patch.group_controls_templates = body.group_controls_templates;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No patchable fields supplied" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Verify dealer belongs to this group before patching.
  const { data: check } = await admin
    .from("dealers")
    .select("id, group_id")
    .eq("id", params.dealerId)
    .maybeSingle<{ id: string; group_id: string | null }>();
  if (!check || check.group_id !== params.id) {
    return NextResponse.json({ error: "Dealer not in this group" }, { status: 404 });
  }

  const { data, error: dbError } = await admin
    .from("dealers")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update(patch as any)
    .eq("id", params.dealerId)
    .select()
    .single();

  if (dbError || !data) {
    return NextResponse.json(
      { error: dbError?.message ?? "Update failed" },
      { status: dbError ? 500 : 404 }
    );
  }

  return NextResponse.json({ data: data as DealerRow });
}
