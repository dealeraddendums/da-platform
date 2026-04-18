import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { groupId: string } };

function canManage(claims: { role: string; group_id: string | null }, groupId: string) {
  if (claims.role === "super_admin") return true;
  if (claims.role === "group_admin" && claims.group_id === groupId) return true;
  return false;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!canManage(claims, params.groupId) && claims.group_id !== params.groupId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_options")
    .select("*")
    .eq("group_id", params.groupId)
    .order("sort_order");

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { option_name?: string; option_price?: string; sort_order?: number };
  if (!body.option_name?.trim()) {
    return NextResponse.json({ error: "option_name required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_options")
    .insert({
      group_id: params.groupId,
      option_name: body.option_name.trim(),
      option_price: body.option_price?.trim() ?? "NC",
      sort_order: body.sort_order ?? 0,
    })
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
