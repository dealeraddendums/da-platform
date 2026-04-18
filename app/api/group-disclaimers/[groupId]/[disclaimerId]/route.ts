import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string; disclaimerId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string) {
  if (claims.role === "super_admin") return true;
  if (claims.role === "group_admin" && claims.group_id === groupId) return true;
  return false;
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as Record<string, unknown>;
  const allowed = ["disclaimer_text", "state_code", "document_type", "active"];
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
  if (patch.state_code) patch.state_code = (patch.state_code as string).toUpperCase().trim();

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_disclaimers")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", params.disclaimerId)
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
    .from("group_disclaimers")
    .delete()
    .eq("id", params.disclaimerId)
    .eq("group_id", params.groupId);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
