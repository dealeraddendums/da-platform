import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/** GET /api/admin/settings?key=last_dealer_sync — super_admin only */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const key = new URL(req.url).searchParams.get("key");
  if (!key) return NextResponse.json({ error: "key required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("admin_settings")
    .select("value, updated_at")
    .eq("key", key)
    .maybeSingle<{ value: string | null; updated_at: string }>();

  return NextResponse.json({ key, value: data?.value ?? null, updated_at: data?.updated_at ?? null });
}
