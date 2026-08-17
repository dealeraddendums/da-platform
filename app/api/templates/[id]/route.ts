import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { templateWriteLockGuard } from "@/lib/dealer-authz";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { TemplateUpdate } from "@/lib/db";

type Params = { params: { id: string } };

async function fetchAndAuthorize(
  claims: JwtClaims,
  templateId: string
): Promise<{ dealerId: string } | { authError: NextResponse }> {
  const admin = createAdminSupabaseClient();
  const { data: tmpl } = await admin
    .from("templates")
    .select("dealer_id")
    .eq("id", templateId)
    .single();

  if (!tmpl) {
    return { authError: NextResponse.json({ error: "Template not found" }, { status: 404 }) };
  }

  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (tmpl.dealer_id !== claims.dealer_id) {
      return { authError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  } else if (claims.role === "group_admin") {
    const { data: dealer } = await admin
      .from("dealers")
      .select("group_id")
      .eq("dealer_id", tmpl.dealer_id)
      .single();
    if (!dealer || dealer.group_id !== claims.group_id) {
      return { authError: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
  }
  // super_admin: allow all

  return { dealerId: tmpl.dealer_id };
}

export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // First try the dealer's own templates table.
  const { data: ownTpl } = await admin
    .from("templates")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (ownTpl) {
    const checked = await fetchAndAuthorize(claims, params.id);
    if ("authError" in checked) return checked.authError;
    return NextResponse.json({ data: { ...ownTpl, source: "dealer" } });
  }

  // Fall through to group_templates if the dealer has a valid assignment.
  // dealer-* roles must have a matching dealer_template_assignments row;
  // group_admin / super_admin can read directly.
  const { data: groupTpl } = await admin
    .from("group_templates")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!groupTpl) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
    if (!claims.dealer_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // dealer_template_assignments.dealer_id is the dealers.id UUID — resolve
    // it from the text code in claims before the lookup.
    const { data: dealerRow } = await admin
      .from("dealers")
      .select("id")
      .eq("dealer_id", claims.dealer_id)
      .maybeSingle<{ id: string }>();
    if (!dealerRow?.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: assignment } = await admin
      .from("dealer_template_assignments")
      .select("dealer_editable, group_id")
      .eq("dealer_id", dealerRow.id)
      .eq("template_id", params.id)
      .maybeSingle<{ dealer_editable: boolean; group_id: string }>();
    if (!assignment) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({
      data: {
        ...groupTpl,
        group_template_id: params.id,
        group_id: assignment.group_id,
        is_locked: assignment.dealer_editable !== true,
        source: "group",
      },
    });
  } else if (claims.role === "group_admin") {
    if (groupTpl.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
  return NextResponse.json({
    data: {
      ...groupTpl,
      group_template_id: params.id,
      source: "group",
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const checked = await fetchAndAuthorize(claims, params.id);
  if ("authError" in checked) return checked.authError;

  // Group-controlled templates: dealer roles may not edit (keyed off the
  // template's own dealer; group roles/super_admin pass).
  const patchLock = await templateWriteLockGuard(claims, checked.dealerId);
  if (patchLock) return patchLock;

  let body: { name?: string; document_type?: string; vehicle_types?: string[]; template_json?: Record<string, unknown>; is_active?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.document_type !== undefined && body.document_type !== "addendum" && body.document_type !== "infosheet") {
    return NextResponse.json({ error: "document_type must be addendum or infosheet" }, { status: 400 });
  }

  const patch: TemplateUpdate = {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.document_type !== undefined && { document_type: body.document_type as "addendum" | "infosheet" }),
    ...(body.vehicle_types !== undefined && { vehicle_types: body.vehicle_types }),
    ...(body.template_json !== undefined && { template_json: body.template_json }),
    ...(body.is_active !== undefined && { is_active: body.is_active }),
  };

  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: updateErr } = await admin
    .from("templates")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ data });
}

export async function DELETE(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const checked = await fetchAndAuthorize(claims, params.id);
  if ("authError" in checked) return checked.authError;
  const { dealerId } = checked;

  // Group-controlled templates: dealer roles may not delete.
  const delLock = await templateWriteLockGuard(claims, dealerId);
  if (delLock) return delLock;

  const admin = createAdminSupabaseClient();

  // Refuse to delete a template that is currently assigned as any default
  const { data: settings } = await admin
    .from("dealer_settings")
    .select("default_addendum_new, default_addendum_used, default_addendum_cpo, default_infosheet_new, default_infosheet_used, default_infosheet_cpo, default_buyersguide_new, default_buyersguide_used, default_buyersguide_cpo")
    .eq("dealer_id", dealerId)
    .maybeSingle();

  if (settings) {
    // Name every default slot this template currently occupies so the operator
    // knows exactly which default(s) to reassign before deleting.
    const SLOT_LABELS: Record<string, string> = {
      default_addendum_new: "Addendum · New Vehicles",
      default_addendum_used: "Addendum · Used Vehicles",
      default_addendum_cpo: "Addendum · CPO Vehicles",
      default_infosheet_new: "Infosheet · New Vehicles",
      default_infosheet_used: "Infosheet · Used Vehicles",
      default_infosheet_cpo: "Infosheet · CPO Vehicles",
      default_buyersguide_new: "Buyer's Guide · New Vehicles",
      default_buyersguide_used: "Buyer's Guide · Used Vehicles",
      default_buyersguide_cpo: "Buyer's Guide · CPO Vehicles",
    };
    const occupied = Object.keys(SLOT_LABELS).filter(
      (col) => (settings as Record<string, string | null>)[col] === params.id
    );
    if (occupied.length) {
      const which = occupied.map((c) => SLOT_LABELS[c]).join(", ");
      return NextResponse.json({
        error: `This template is the default for: ${which}. Change ${occupied.length === 1 ? "that default" : "those defaults"} first, then delete.`,
      }, { status: 409 });
    }
  }

  const { error: deleteErr } = await admin
    .from("templates")
    .delete()
    .eq("id", params.id);

  if (deleteErr) {
    return NextResponse.json({ error: deleteErr.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
