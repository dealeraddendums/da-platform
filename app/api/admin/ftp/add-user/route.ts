import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { addUser, cerberusConfigured, CerberusError } from "@/lib/cerberus";

const PASSWORD_RE = /^(?=.{10,})(?=.*?[^\w\s])(?=.*?[0-9])(?=.*?[A-Z]).*?[a-z].*$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/**
 * POST /api/admin/ftp/add-user
 * Body: { username, password, folderName?, note? }
 *
 * Creates (or overwrites — Cerberus AddUser is upsert) the FTP user, then
 * stores the note in Supabase. super_admin only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cerberusConfigured()) {
    return NextResponse.json({ error: "Cerberus SOAP not configured" }, { status: 500 });
  }

  let body: { username?: string; password?: string; folderName?: string; note?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const username = body.username?.trim();
  const password = body.password;
  const folderName = body.folderName?.trim() || undefined;
  const note = body.note?.trim() ?? "";

  if (!username || !USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "Invalid username (letters, numbers, _ or - only; up to 32 chars)" }, { status: 400 });
  }
  if (!password || !PASSWORD_RE.test(password)) {
    return NextResponse.json({ error: "Password must be 10+ chars with upper, lower, number, and one special char" }, { status: 400 });
  }

  try {
    const result = await addUser({ username, password, folderName });
    if (!result.ok) {
      return NextResponse.json({ error: result.message ?? "Cerberus AddUser failed" }, { status: 502 });
    }
  } catch (err) {
    if (err instanceof CerberusError) {
      return NextResponse.json({ error: `Cerberus: ${err.faultString ?? err.message}` }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Best-effort note save. If it fails, the user is still created — note
  // can be added later via the Add/Edit Note button.
  if (note) {
    try {
      const admin = createAdminSupabaseClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("ftp_users").upsert(
        { username, note },
        { onConflict: "username" },
      );
    } catch (noteErr) {
      console.error("[ftp/add-user] note save failed:", noteErr instanceof Error ? noteErr.message : noteErr);
    }
  }

  return NextResponse.json({ ok: true, username });
}
