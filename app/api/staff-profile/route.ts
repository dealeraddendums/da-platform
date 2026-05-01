import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createAdminSupabaseClient();

  let { data: staffProfile } = await admin
    .from("staff_profiles")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();

  // Auto-create an empty row on first access
  if (!staffProfile) {
    const { data: newRow } = await admin
      .from("staff_profiles")
      .insert({ user_id: session.user.id })
      .select("*")
      .single();
    staffProfile = newRow;
  }

  return NextResponse.json({ staffProfile });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

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

  // Upsert — ensures the row exists even if GET wasn't called first
  const { data, error } = await admin
    .from("staff_profiles")
    .upsert({ user_id: session.user.id, ...updates }, { onConflict: "user_id" })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ staffProfile: data });
}
