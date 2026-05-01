import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createAdminSupabaseClient();

  // Verify ownership before deleting
  const { data: passkey } = await admin
    .from("passkeys")
    .select("user_id")
    .eq("id", params.id)
    .single<{ user_id: string }>();

  if (!passkey || passkey.user_id !== session.user.id) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }

  const { error } = await admin.from("passkeys").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  let body: { friendly_name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: passkey } = await admin
    .from("passkeys")
    .select("user_id")
    .eq("id", params.id)
    .single<{ user_id: string }>();

  if (!passkey || passkey.user_id !== session.user.id) {
    return NextResponse.json({ error: "Passkey not found" }, { status: 404 });
  }

  if (body.friendly_name !== undefined) {
    const { error } = await admin
      .from("passkeys")
      .update({ friendly_name: body.friendly_name })
      .eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
