import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { userId: string } }
): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const allowed = [
    "full_name", "title", "phone", "mobile", "sms_enabled",
    "avatar_url", "timezone", "on_call", "on_call_start", "on_call_end",
    "on_call_days", "notification_email", "notification_sms", "notes",
  ];
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (key in body) updates[key] = body[key];
  }

  const admin = createAdminSupabaseClient();

  const { data, error: dbError } = await admin
    .from("staff_profiles")
    .upsert({ user_id: params.userId, ...updates }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (dbError) return NextResponse.json({ error: dbError.message }, { status: 500 });
  return NextResponse.json({ staffProfile: data });
}
