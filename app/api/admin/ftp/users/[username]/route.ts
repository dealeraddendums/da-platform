import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { deleteUser, cerberusConfigured, CerberusError } from "@/lib/cerberus";

type Params = { params: { username: string } };

/**
 * DELETE /api/admin/ftp/users/[username]
 *
 * Removes the FTP user account from Cerberus. Does NOT delete the user's
 * folder on disk (`C:\ftproot\{username}` stays intact). Also removes any
 * note for the user from Supabase. super_admin only.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cerberusConfigured()) {
    return NextResponse.json({ error: "Cerberus SOAP not configured" }, { status: 500 });
  }

  const username = decodeURIComponent(params.username).trim();
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  // Refuse to delete the admin account.
  if (username.toLowerCase() === "admin" || username.toLowerCase() === "allantone") {
    return NextResponse.json({ error: `Cannot delete protected user "${username}"` }, { status: 403 });
  }

  try {
    const result = await deleteUser(username);
    if (!result.ok) {
      return NextResponse.json({ error: result.message ?? "Cerberus DeleteUser failed" }, { status: 502 });
    }
  } catch (err) {
    if (err instanceof CerberusError) {
      return NextResponse.json({ error: `Cerberus: ${err.faultString ?? err.message}` }, { status: 502 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Best-effort note cleanup.
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("ftp_users").delete().eq("username", username);
  } catch (noteErr) {
    console.error("[ftp/delete] note cleanup failed:", noteErr instanceof Error ? noteErr.message : noteErr);
  }

  return NextResponse.json({ ok: true });
}
