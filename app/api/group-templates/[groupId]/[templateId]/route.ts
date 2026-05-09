import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string; templateId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string) {
  if (claims.role === "super_admin") return true;
  if (claims.role === "group_admin" && claims.group_id === groupId) return true;
  return false;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  // Anyone in the group can read; super_admin too. Dealers in the group can
  // load locked group templates into their Builder for reference.
  const inGroup = claims.role === "super_admin" || claims.group_id === params.groupId;
  if (!inGroup && claims.role !== "dealer_admin" && claims.role !== "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_templates")
    .select("*")
    .eq("id", params.templateId)
    .eq("group_id", params.groupId)
    .maybeSingle();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as Record<string, unknown>;
  const allowed = ["name", "document_type", "vehicle_types", "template_json", "is_locked", "is_active"];
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_templates")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", params.templateId)
    .eq("group_id", params.groupId)
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { error: dbErr } = await admin
    .from("group_templates")
    .delete()
    .eq("id", params.templateId)
    .eq("group_id", params.groupId);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
