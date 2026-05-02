import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";

/**
 * POST /api/admin/create-dealer-user
 * super_admin only. Creates a Supabase auth user + profile for a dealer that has
 * no accounts, then immediately returns impersonation tokens so the admin lands in
 * the dealer context without a second step.
 *
 * Body: { dealer_id: string; email: string; full_name: string; role: "dealer_admin"|"dealer_user" }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { dealer_id?: string; email?: string; full_name?: string; role?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { dealer_id, email, full_name, role } = body;
  if (!dealer_id)    return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  if (!email?.trim()) return NextResponse.json({ error: "Email required" }, { status: 400 });
  if (!full_name?.trim()) return NextResponse.json({ error: "Full name required" }, { status: 400 });
  if (role !== "dealer_admin" && role !== "dealer_user") {
    return NextResponse.json({ error: "Role must be dealer_admin or dealer_user" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Look up dealer
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, dealer_id")
    .eq("dealer_id", dealer_id)
    .maybeSingle<{ id: string; name: string; dealer_id: string }>();

  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // Create Supabase auth user with a known default password
  const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password: "Welcome2DA!",
    email_confirm: true,
    user_metadata: { full_name: full_name.trim() },
  });

  if (createErr || !newUser.user) {
    return NextResponse.json({ error: createErr?.message ?? "Failed to create auth user" }, { status: 500 });
  }

  // Create profile
  const { error: profileErr } = await admin.from("profiles").insert({
    id: newUser.user.id,
    email: email.trim().toLowerCase(),
    full_name: full_name.trim(),
    role,
    dealer_id,
  });

  if (profileErr) {
    // Clean up the auth user so it's not an orphan
    await admin.auth.admin.deleteUser(newUser.user.id);
    return NextResponse.json({ error: `Failed to create profile: ${profileErr.message}` }, { status: 500 });
  }

  // Send welcome email
  try {
    await sendMandrillEmail({
      subject: `Your DealerAddendums account has been created — ${dealer.name}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DealerAddendums",
      to: [{ email: email.trim(), name: full_name.trim(), type: "to" }],
      html: `
<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333;">
  <div style="margin-bottom: 24px;">
    <img src="https://new-infobox-images.s3.us-east-1.amazonaws.com/da-logo.png" alt="DA Platform" width="40" height="40" style="border-radius: 50%;" />
  </div>
  <h2 style="font-size: 20px; font-weight: 600; margin: 0 0 8px;">Your DA Platform account is ready</h2>
  <p style="margin: 0 0 16px; color: #55595c;">Hi ${full_name.trim()},</p>
  <p style="margin: 0 0 16px; color: #55595c;">
    Your account for <strong>${dealer.name}</strong> on DealerAddendums Platform has been created.
  </p>
  <div style="background: #f5f6f7; border-radius: 4px; padding: 16px 20px; margin: 0 0 24px;">
    <p style="margin: 0 0 6px; font-size: 13px; color: #55595c;"><strong>Login URL:</strong> <a href="https://app.dealeraddendums.com/login" style="color: #1976d2;">app.dealeraddendums.com/login</a></p>
    <p style="margin: 0 0 6px; font-size: 13px; color: #55595c;"><strong>Email:</strong> ${email.trim().toLowerCase()}</p>
    <p style="margin: 0; font-size: 13px; color: #55595c;"><strong>Temporary password:</strong> Welcome2DA!</p>
  </div>
  <p style="color: #78828c; font-size: 12px; margin: 0;">
    Please change your password after your first login. If you did not expect this email, contact support at support@dealeraddendums.com.
  </p>
</div>
`,
    });
  } catch (emailErr) {
    console.error("[create-dealer-user] Mandrill failed:", emailErr instanceof Error ? emailErr.message : emailErr);
  }

  // Log the action
  void admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "create_dealer_user",
    target_dealer_id: dealer_id,
    metadata: { email: email.trim(), full_name: full_name.trim(), role, dealer_name: dealer.name },
  });

  // Generate impersonation tokens so the admin lands in the dealer context immediately
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: email.trim().toLowerCase(),
  });

  if (linkError || !linkData) {
    // User was created — just return success without auto-impersonation
    return NextResponse.json({ ok: true, impersonation: false });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": supabaseAnonKey },
    body: JSON.stringify({ token_hash: linkData.properties.hashed_token, type: "magiclink" }),
  });

  if (!verifyRes.ok) {
    return NextResponse.json({ ok: true, impersonation: false });
  }

  const sessionData = await verifyRes.json() as {
    access_token?: string; refresh_token?: string;
  };

  if (!sessionData.access_token || !sessionData.refresh_token) {
    return NextResponse.json({ ok: true, impersonation: false });
  }

  return NextResponse.json({
    ok: true,
    impersonation: true,
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
    dealer_name: dealer.name,
    dealer_id: dealer.dealer_id,
  });
}
