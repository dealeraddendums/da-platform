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
    .from("group_disclaimers")
    .select("*")
    .eq("group_id", params.groupId)
    .order("state_code");

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!canManage(claims, params.groupId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json() as { disclaimer_text?: string; state_code?: string; document_type?: string };
  if (!body.disclaimer_text?.trim()) {
    return NextResponse.json({ error: "disclaimer_text required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("group_disclaimers")
    .insert({
      group_id: params.groupId,
      disclaimer_text: body.disclaimer_text.trim(),
      state_code: body.state_code?.toUpperCase().trim() ?? "ALL",
      document_type: body.document_type ?? "all",
    })
    .select("*")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
