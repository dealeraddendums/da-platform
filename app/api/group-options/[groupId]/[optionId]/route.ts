import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string; optionId: string } };

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
  const allowed = ["option_name", "option_price", "sort_order", "active"];
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_options")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", params.optionId)
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
    .from("group_options")
    .delete()
    .eq("id", params.optionId)
    .eq("group_id", params.groupId);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
