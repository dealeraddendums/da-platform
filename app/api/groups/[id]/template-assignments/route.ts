import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerTemplateAssignmentRow, GroupTemplateRow } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]/template-assignments
 * List all template assignments for this group.
 */
export async function GET(
  _req: NextRequest,
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

  const admin = createAdminSupabaseClient();
  const { data, error: dbError } = await admin
    .from("dealer_template_assignments")
    .select("*")
    .eq("group_id", params.id)
    .order("assigned_at", { ascending: false });

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ data: (data as DealerTemplateAssignmentRow[]) ?? [] });
}

/**
 * POST /api/groups/[id]/template-assignments
 * Assign a group template to one or more dealers.
 * Body: { template_id: string, dealer_ids: string[], dealer_editable: boolean }
 *
 * If dealer_editable=true: copies the template to each dealer's templates library.
 * If dealer_editable=false: creates a locked assignment (dealer can load but not save).
 */
export async function POST(
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

  let body: { template_id?: string; dealer_ids?: string[]; dealer_editable?: boolean };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { template_id, dealer_ids, dealer_editable = false } = body;
  if (!template_id) return NextResponse.json({ error: "template_id required" }, { status: 400 });
  if (!dealer_ids?.length) return NextResponse.json({ error: "dealer_ids required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // Verify template belongs to this group
  const { data: tpl } = await admin
    .from("group_templates")
    .select("*")
    .eq("id", template_id)
    .eq("group_id", params.id)
    .maybeSingle<GroupTemplateRow>();

  if (!tpl) {
    return NextResponse.json({ error: "Template not found in this group" }, { status: 404 });
  }

  const rows = dealer_ids.map((dealer_id) => ({
    dealer_id,
    template_id,
    group_id: params.id,
    dealer_editable,
    assigned_by: claims.sub,
  }));

  const { error: upsertErr } = await admin
    .from("dealer_template_assignments")
    .upsert(rows, { onConflict: "dealer_id,template_id" });

  if (upsertErr) {
    return NextResponse.json({ error: upsertErr.message }, { status: 500 });
  }

  // If dealer_editable=true, copy template to each dealer's own template
  // library. templates.dealer_id is the TEXT dealer code (FK to
  // dealers.dealer_id), while the dealer_ids array carries UUIDs (FK to
  // dealers.id) — resolve UUID → text first or the insert fails the FK.
  if (dealer_editable) {
    const { data: dealerTextRows } = await admin
      .from("dealers")
      .select("id, dealer_id")
      .in("id", dealer_ids);
    const uuidToText = new Map<string, string>(
      (dealerTextRows ?? []).map((d: { id: string; dealer_id: string }) => [d.id, d.dealer_id]),
    );
    const copies = dealer_ids
      .map((uuid) => {
        const textId = uuidToText.get(uuid);
        if (!textId) return null;
        return {
          dealer_id: textId,
          name: tpl.name,
          document_type: tpl.document_type,
          vehicle_types: tpl.vehicle_types,
          template_json: tpl.template_json,
          is_active: true,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (copies.length > 0) {
      // Use insert (not upsert) — dealer gets their own copy to edit
      await admin.from("templates").insert(copies);
    }
  }

  return NextResponse.json({ ok: true, assigned: dealer_ids.length });
}

/**
 * DELETE /api/groups/[id]/template-assignments
 * Remove a template assignment.
 * Body: { template_id: string, dealer_id: string }
 */
export async function DELETE(
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

  let body: { template_id?: string; dealer_id?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.template_id || !body.dealer_id) {
    return NextResponse.json({ error: "template_id and dealer_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { error: dbError } = await admin
    .from("dealer_template_assignments")
    .delete()
    .eq("template_id", body.template_id)
    .eq("dealer_id", body.dealer_id)
    .eq("group_id", params.id);

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
