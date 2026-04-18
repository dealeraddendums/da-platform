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
    .from("group_templates")
    .select("*")
    .eq("group_id", params.groupId)
    .order("created_at", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as {
    name?: string;
    document_type?: string;
    vehicle_types?: string[];
    template_json?: Record<string, unknown>;
    is_locked?: boolean;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body.document_type) return NextResponse.json({ error: "document_type required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_templates")
    .insert({
      group_id: params.groupId,
      name: body.name.trim(),
      document_type: body.document_type as "addendum" | "infosheet",
      vehicle_types: body.vehicle_types ?? [],
      template_json: body.template_json ?? {},
      is_locked: body.is_locked ?? false,
    })
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
