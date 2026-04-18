import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(req: NextRequest): Promise<NextResponse> {
  void req;
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "super_admin only" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_overrides")
    .select("*")
    .order("created_at", { ascending: false });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "super_admin only" }, { status: 403 });

  const body = await req.json() as Record<string, unknown>;
  if (!body.vin_prefix) return NextResponse.json({ error: "vin_prefix is required" }, { status: 422 });

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_overrides")
    .insert({
      vin_prefix: String(body.vin_prefix).toUpperCase(),
      year: body.year ? Number(body.year) : null,
      make: (body.make as string) || null,
      model: (body.model as string) || null,
      trim: (body.trim as string) || null,
      body_style: (body.body_style as string) || null,
      engine: (body.engine as string) || null,
      transmission: (body.transmission as string) || null,
      drivetrain: (body.drivetrain as string) || null,
      notes: (body.notes as string) || null,
      created_by: claims.sub,
    })
    .select()
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
