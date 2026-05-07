import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/** PATCH /api/admin/image-library/meta/[id] — update display_name (super_admin only) */
export async function PATCH(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { display_name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.display_name?.trim();
  if (!name) {
    return NextResponse.json({ error: "display_name required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("image_library")
    .update({ display_name: name })
    .eq("id", params.id)
    .select("id, display_name")
    .single();

  if (dbErr || !data) {
    return NextResponse.json({ error: dbErr?.message ?? "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ data });
}
