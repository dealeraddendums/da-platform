import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/** PATCH /api/custom-sizes/[id] — update name, dimensions, or background_url */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: existing } = await admin
    .from("dealer_custom_sizes")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (claims.role === "dealer_admin" && existing.dealer_id !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { name?: string; width_in?: number; height_in?: number; background_url?: string | null };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim() ?? existing.name;
  const widthIn = body.width_in !== undefined ? Number(body.width_in) : existing.width_in;
  const heightIn = body.height_in !== undefined ? Number(body.height_in) : existing.height_in;
  const backgroundUrl = body.background_url !== undefined ? body.background_url : existing.background_url;

  const { data, error: dbErr } = await admin
    .from("dealer_custom_sizes")
    .update({ name, width_in: widthIn, height_in: heightIn, background_url: backgroundUrl, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data });
}

/** DELETE /api/custom-sizes/[id] */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user" || claims.role === "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data: existing } = await admin
    .from("dealer_custom_sizes")
    .select("dealer_id")
    .eq("id", params.id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (claims.role === "dealer_admin" && existing.dealer_id !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await admin.from("dealer_custom_sizes").delete().eq("id", params.id);
  return NextResponse.json({ ok: true });
}
