import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const TYPES = ["info", "warning", "success", "error"];

type Params = { params: { id: string } };

// PATCH — update a banner (super_admin only). Accepts any subset of fields.
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.message !== undefined) {
    const m = typeof body.message === "string" ? body.message.trim() : "";
    if (!m) return NextResponse.json({ error: "Message cannot be empty" }, { status: 400 });
    patch.message = m;
  }
  if (body.banner_type !== undefined) {
    if (!TYPES.includes(body.banner_type as string))
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    patch.banner_type = body.banner_type;
  }
  if (body.starts_at !== undefined) {
    if (typeof body.starts_at !== "string" || Number.isNaN(Date.parse(body.starts_at)))
      return NextResponse.json({ error: "Invalid start date/time" }, { status: 400 });
    patch.starts_at = new Date(body.starts_at).toISOString();
  }
  if (body.ends_at !== undefined) {
    if (body.ends_at && (typeof body.ends_at !== "string" || Number.isNaN(Date.parse(body.ends_at))))
      return NextResponse.json({ error: "Invalid end date/time" }, { status: 400 });
    patch.ends_at = body.ends_at ? new Date(body.ends_at as string).toISOString() : null;
  }
  if (
    typeof patch.starts_at === "string" &&
    typeof patch.ends_at === "string" &&
    Date.parse(patch.ends_at) <= Date.parse(patch.starts_at)
  ) {
    return NextResponse.json({ error: "End must be after start" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient() as any;
  const { data, error: dbErr } = await admin
    .from("platform_banners")
    .update(patch)
    .eq("id", params.id)
    .select()
    .maybeSingle();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Banner not found" }, { status: 404 });
  return NextResponse.json({ banner: data });
}

// DELETE — remove a banner (super_admin only).
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;
  const { error: dbErr } = await admin.from("platform_banners").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
