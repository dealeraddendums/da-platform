import { NextRequest, NextResponse } from "next/server";
import { makeKey } from "@/lib/make-key";
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

  let body: { template_id?: string; dealer_ids?: string[]; dealer_editable?: boolean; set_as_default?: "new" | "used" | "both" | "neither"; make?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { template_id, dealer_ids, dealer_editable = false, set_as_default = "neither", make = null } = body;
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

  // If editable, copy template into each dealer's own library. A dealer that
  // already has a copy (same name + document_type) gets that copy refreshed in
  // place — re-running the assign must not mint another duplicate (it used to:
  // every assign click inserted a new copy, which is how the Bill Jacobs
  // dealers ended up with 3 identically-named rows each in their dropdown).
  if (dealer_editable) {
    const textIds = dealer_ids
      .map((uuid) => uuidToText.get(uuid))
      .filter((t): t is string => !!t);

    const { data: existingCopies, error: existingErr } = await admin
      .from("templates")
      .select("id, dealer_id")
      .in("dealer_id", textIds)
      .eq("name", tpl.name)
      .eq("document_type", tpl.document_type);
    if (existingErr) {
      return NextResponse.json({ error: `Failed to check existing dealer copies: ${existingErr.message}` }, { status: 500 });
    }
    const hasCopy = new Set((existingCopies ?? []).map((r) => r.dealer_id as string));

    const freshFields = {
      vehicle_types: tpl.vehicle_types,
      template_json: tpl.template_json,
      is_active: true,
    };

    const inserts = textIds
      .filter((textId) => !hasCopy.has(textId))
      .map((textId) => ({
        dealer_id: textId,
        name: tpl.name,
        document_type: tpl.document_type,
        ...freshFields,
      }));
    if (inserts.length > 0) {
      const { error: insErr } = await admin.from("templates").insert(inserts);
      if (insErr) {
        return NextResponse.json({ error: `Failed to copy template to dealers: ${insErr.message}` }, { status: 500 });
      }
    }
    for (const row of existingCopies ?? []) {
      const { error: updErr } = await admin.from("templates").update(freshFields).eq("id", row.id);
      if (updErr) {
        return NextResponse.json({ error: `Failed to refresh dealer copy: ${updErr.message}` }, { status: 500 });
      }
    }
  }

  // If set_as_default requested, point each assigned dealer's default ADDENDUM
  // template at this group template. NOTE: the print path (pdf/generate, bulk,
  // templates route) AND the Settings UI dropdown resolve the default from
  // default_addendum_new/used. Do NOT write the legacy default_template_*
  // columns here: they still carry an FK to templates(id), so a group-template
  // id is rejected — that FK violation used to kill this entire upsert
  // silently, which is why "Set as default" never took effect.
  // Brand override (migration 153): when a make is supplied, this assignment
  // means "vehicles of THIS make print this group template" rather than
  // "this is the dealer's default". Group-managed rooftops are 22 of the 33
  // mixed-make dealers, so the group side needs the same lever as Settings.
  // The dealer's normal defaults are deliberately left untouched.
  if (make) {
    const makeKeyValue = makeKey(String(make));
    if (!makeKeyValue) return NextResponse.json({ error: "Make must contain at least one letter or digit" }, { status: 400 });
    const condition = set_as_default === "new" ? "new" : set_as_default === "used" ? "used" : "any";
    const overrideRows = dealer_ids
      .map((uuid: string) => uuidToText.get(uuid))
      .filter((textId: string | undefined): textId is string => !!textId)
      .map((textId: string) => ({
        dealer_id: textId, make_key: makeKeyValue, condition, doc_type: "addendum", template_id: tpl.id,
      }));
    if (overrideRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: ovErr } = await (admin as any)
        .from("template_make_overrides")
        .upsert(overrideRows, { onConflict: "dealer_id,make_key,condition,doc_type" });
      if (ovErr) {
        return NextResponse.json({ error: `Assigned, but setting the brand override failed: ${ovErr.message}` }, { status: 500 });
      }
    }
    return NextResponse.json({ ok: true, assigned: dealer_ids.length, make_key: makeKeyValue, condition });
  }

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
      const { error: settingsErr } = await admin
        .from("dealer_settings")
        .upsert(settingsUpdates, { onConflict: "dealer_id" });
      if (settingsErr) {
        return NextResponse.json({ error: `Assigned, but setting dealer defaults failed: ${settingsErr.message}` }, { status: 500 });
      }
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
