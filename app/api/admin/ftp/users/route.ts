import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getUserList, cerberusConfigured, CerberusError } from "@/lib/cerberus";

/**
 * GET /api/admin/ftp/users
 *
 * Returns the live list of FTP usernames from Cerberus, merged with any
 * notes from the ftp_users Supabase table. Sorted alphabetically.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  if (!cerberusConfigured()) {
    return NextResponse.json({ error: "Cerberus SOAP not configured" }, { status: 500 });
  }

  let usernames: string[] = [];
  try {
    usernames = await getUserList();
  } catch (err) {
    if (err instanceof CerberusError) {
      return NextResponse.json({
        error: `Cerberus: ${err.faultString ?? err.message}`,
        status: err.status,
      }, { status: 502 });
    }
    return NextResponse.json({
      error: err instanceof Error ? err.message : String(err),
    }, { status: 502 });
  }

  // Pull notes for the same usernames so the UI can render the note column
  // without a second roundtrip.
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: notesRaw } = await (admin as any)
    .from("ftp_users")
    .select("username, note")
    .in("username", usernames);
  const noteMap = new Map<string, string>();
  for (const r of (notesRaw ?? []) as Array<{ username: string; note: string | null }>) {
    if (r.note) noteMap.set(r.username, r.note);
  }

  const data = usernames
    .map((u) => ({ username: u, note: noteMap.get(u) ?? "" }))
    .sort((a, b) => a.username.localeCompare(b.username));

  return NextResponse.json({ data, total: data.length });
}
