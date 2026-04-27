import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
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

  const checked = await fetchAndAuthorize(claims, params.id);
  if ("authError" in checked) return checked.authError;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("templates")
    .select("*")
    .eq("id", params.id)
    .single();

  return NextResponse.json({ data });
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

  const admin = createAdminSupabaseClient();

  // Refuse to delete a template that is currently assigned as any default
  const { data: settings } = await admin
    .from("dealer_settings")
    .select("default_addendum_new, default_addendum_used, default_addendum_cpo, default_infosheet_new, default_infosheet_used, default_infosheet_cpo, default_buyersguide_new, default_buyersguide_used, default_buyersguide_cpo")
    .eq("dealer_id", dealerId)
    .maybeSingle();

  if (settings) {
    const assignedIds = [
      settings.default_addendum_new, settings.default_addendum_used, settings.default_addendum_cpo,
      settings.default_infosheet_new, settings.default_infosheet_used, settings.default_infosheet_cpo,
      settings.default_buyersguide_new, settings.default_buyersguide_used, settings.default_buyersguide_cpo,
    ];
    if (assignedIds.includes(params.id)) {
      return NextResponse.json({ error: "Template is assigned as a default and cannot be deleted" }, { status: 409 });
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
