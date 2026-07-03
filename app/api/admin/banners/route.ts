import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const TYPES = ["info", "warning", "success", "error"];

// GET — all banners (super_admin only), newest start first.
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;
  const { data, error: dbErr } = await admin
    .from("platform_banners")
    .select("*")
    .order("starts_at", { ascending: false });
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ banners: data ?? [] });
}

// POST — create a banner (super_admin only).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const banner_type = TYPES.includes(body.banner_type as string) ? (body.banner_type as string) : "info";
  const starts_at = typeof body.starts_at === "string" ? body.starts_at : "";
  const ends_at = typeof body.ends_at === "string" && body.ends_at ? body.ends_at : null;

  if (!message) return NextResponse.json({ error: "Message is required" }, { status: 400 });
  if (!starts_at || Number.isNaN(Date.parse(starts_at)))
    return NextResponse.json({ error: "A valid start date/time is required" }, { status: 400 });
  if (ends_at && Number.isNaN(Date.parse(ends_at)))
    return NextResponse.json({ error: "Invalid end date/time" }, { status: 400 });
  if (ends_at && Date.parse(ends_at) <= Date.parse(starts_at))
    return NextResponse.json({ error: "End must be after start" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const row = {
    message,
    banner_type,
    starts_at: new Date(starts_at).toISOString(),
    ends_at: ends_at ? new Date(ends_at).toISOString() : null,
    created_by: claims.sub,
  };

  let { data, error: dbErr } = await admin.from("platform_banners").insert(row).select().single();
  // created_by references profiles(id); a super_admin's auth uid may not map to a
  // profiles row in every case — retry without the audit column rather than fail.
  if (dbErr && /foreign key|violates|23503/i.test(dbErr.message)) {
    ({ data, error: dbErr } = await admin
      .from("platform_banners")
      .insert({ ...row, created_by: null })
      .select()
      .single());
  }
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ banner: data }, { status: 201 });
}
