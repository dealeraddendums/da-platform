import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "super_admin only" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_overrides")
    .update({
      vin_prefix: body.vin_prefix ? String(body.vin_prefix).toUpperCase() : undefined,
      year: body.year !== undefined ? (body.year ? Number(body.year) : null) : undefined,
      make: body.make !== undefined ? ((body.make as string) || null) : undefined,
      model: body.model !== undefined ? ((body.model as string) || null) : undefined,
      trim: body.trim !== undefined ? ((body.trim as string) || null) : undefined,
      body_style: body.body_style !== undefined ? ((body.body_style as string) || null) : undefined,
      engine: body.engine !== undefined ? ((body.engine as string) || null) : undefined,
      transmission: body.transmission !== undefined ? ((body.transmission as string) || null) : undefined,
      drivetrain: body.drivetrain !== undefined ? ((body.drivetrain as string) || null) : undefined,
      notes: body.notes !== undefined ? ((body.notes as string) || null) : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  void req;
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "super_admin only" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { error: dbErr } = await admin
    .from("nhtsa_overrides")
    .delete()
    .eq("id", params.id);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
