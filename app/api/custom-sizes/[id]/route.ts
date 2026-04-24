import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { uploadBackground } from "@/lib/s3-upload";

type Params = { params: { id: string } };

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** PATCH /api/custom-sizes/[id] — update name, dimensions, or background */
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

  let formData: FormData;
  try { formData = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const name = (formData.get("name") as string | null)?.trim() ?? existing.name;
  const widthIn = formData.get("width_in") ? parseFloat(formData.get("width_in") as string) : existing.width_in;
  const heightIn = formData.get("height_in") ? parseFloat(formData.get("height_in") as string) : existing.height_in;
  const file = formData.get("file") as File | null;

  let backgroundUrl: string | null = existing.background_url;
  if (file && file.size > 0) {
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Background image must be under 5 MB" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const key = `custom/${existing.dealer_id}/${slugify(name)}_${Date.now()}.png`;
    backgroundUrl = await uploadBackground(buffer, key);
  }

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
