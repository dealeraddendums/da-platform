import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { validateFeedBody, type FeedBody } from "@/lib/feed-validation";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: feed } = await (admin as any)
    .from("feed_companies").select("*").eq("id", params.id).maybeSingle();
  if (!feed) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: dealers } = await (admin as any)
    .from("feed_company_dealers")
    .select("id, dealer_uuid, feed_dealer_id, created_at, dealers(id, dealer_id, name)")
    .eq("feed_company_id", params.id)
    .order("created_at", { ascending: true });
  return NextResponse.json({ data: { ...feed, dealers: dealers ?? [] } });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  let body: FeedBody;
  try { body = (await req.json()) as FeedBody; } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const invalid = validateFeedBody(body, true);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ["name", "ftp_url", "ftp_username", "ftp_password", "filename", "protocol", "include_vehicles"] as const) {
    if (typeof body[k] === "string" && (body[k] as string).trim() !== "") patch[k] = k === "ftp_password" ? body[k] : (body[k] as string).trim();
  }
  if (body.ftp_port != null) patch.ftp_port = body.ftp_port;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("feed_companies").update(patch).eq("id", params.id).select("*").maybeSingle();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any)
    .from("feed_companies").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
