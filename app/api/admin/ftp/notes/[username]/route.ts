import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { username: string } };

/**
 * PUT /api/admin/ftp/notes/[username]
 * Body: { note: string }
 *
 * Upserts the note for this FTP username. Empty string clears the row.
 * super_admin only.
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const username = decodeURIComponent(params.username).trim();
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  let body: { note?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const note = (body.note ?? "").trim();

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("ftp_users").upsert(
    { username, note: note || null },
    { onConflict: "username" },
  );
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

/**
 * GET /api/admin/ftp/notes/[username]
 * Returns { note } for the username, or null if no note exists.
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const username = decodeURIComponent(params.username).trim();
  if (!username) return NextResponse.json({ error: "username required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any)
    .from("ftp_users")
    .select("note")
    .eq("username", username)
    .maybeSingle();

  return NextResponse.json({ note: (data as { note: string | null } | null)?.note ?? null });
}
