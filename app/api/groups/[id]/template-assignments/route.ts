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

  let body: { template_id?: string; dealer_ids?: string[]; dealer_editable?: boolean; set_as_default?: "new" | "used" | "both" | "neither" };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { template_id, dealer_ids, dealer_editable = false, set_as_default = "neither" } = body;
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

  // Resolve UUID → text dealer_id once for either the dealer_editable copy or
  // set_as_default. templates.dealer_id / dealer_settings.dealer_id are the TEXT
  // dealer code (FK to dealers.dealer_id), while dealer_ids carries UUIDs (FK to
  // dealers.id) — resolve first or the writes fail the FK.
  const needTextIds = dealer_editable || set_as_default !== "neither";
  let uuidToText = new Map<string, string>();
  if (needTextIds) {
    const { data: dealerTextRows } = await admin
      .from("dealers")
      .select("id, dealer_id")
      .in("id", dealer_ids);
    uuidToText = new Map<string, string>(
      ((dealerTextRows ?? []) as { id: string; dealer_id: string }[]).map((d) => [d.id, d.dealer_id]),
    );
  }

  // If editable, copy template into each dealer's own library
  if (dealer_editable) {
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

  // If set_as_default requested, point each assigned dealer's default ADDENDUM
  // template at this group template. NOTE: the print path (pdf/generate, bulk,
  // templates route) resolves the default from default_addendum_new/used — NOT
  // the legacy default_template_* columns — so we write default_addendum_* so
  // the choice actually takes effect at print time.
  if (set_as_default !== "neither") {
    const settingsUpdates = dealer_ids
      .map((uuid) => uuidToText.get(uuid))
      .filter((textId): textId is string => !!textId)
      .map((textId) => ({
        dealer_id: textId,
        ...(set_as_default === "new" || set_as_default === "both" ? { default_addendum_new: tpl.id } : {}),
        ...(set_as_default === "used" || set_as_default === "both" ? { default_addendum_used: tpl.id } : {}),
      }));

    if (settingsUpdates.length > 0) {
      await admin.from("dealer_settings").upsert(settingsUpdates, { onConflict: "dealer_id" });
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
