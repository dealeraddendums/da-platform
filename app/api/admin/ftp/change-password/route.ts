import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { changePassword, cerberusConfigured, CerberusError } from "@/lib/cerberus";

// FTP account passwords (Allan, 2026-07-28): min 6 chars, >=1 letter,
// >=1 number, >=1 uppercase. No special-char requirement. FTP accounts
// ONLY — platform user passwords keep their own rules.
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[A-Z]).{6,}$/;

/**
 * POST /api/admin/ftp/change-password
 * Body: { username, newPassword }
 *
 * Admin reset — bypasses the old-password requirement. super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cerberusConfigured()) {
    return NextResponse.json({ error: "Cerberus SOAP not configured" }, { status: 500 });
  }

  let body: { username?: string; newPassword?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const username = body.username?.trim();
  const newPassword = body.newPassword;
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });
  if (!newPassword || !PASSWORD_RE.test(newPassword)) {
    return NextResponse.json({ error: "At least 6 characters, with a letter, a number, and an uppercase letter." }, { status: 400 });
  }

  try {
    const result = await changePassword(username, newPassword);
    if (!result.ok) {
      return NextResponse.json({ error: result.message ?? "Cerberus ChangePassword failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CerberusError) {
      return NextResponse.json({ error: `Cerberus: ${err.faultString ?? err.message}` }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
