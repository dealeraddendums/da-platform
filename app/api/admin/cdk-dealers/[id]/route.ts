import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/** PATCH /api/admin/cdk-dealers/[id] — update fields. */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const idNum = parseInt(params.id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Whitelist + normalize. Keep UPPERCASE keys matching the cdk_dealers
  // column names exactly.
  const patch: Record<string, unknown> = {};
  if (typeof body.DEALER_NAME === "string") patch.DEALER_NAME = body.DEALER_NAME.trim();
  if (typeof body.DEALER_ID === "string") patch.DEALER_ID = body.DEALER_ID.trim();
  if (typeof body.ICOMPANY === "string") patch.ICOMPANY = body.ICOMPANY.trim();
  if (typeof body.NEW === "string") patch.NEW = body.NEW === "Yes" ? "Yes" : "No";

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("cdk_dealers")
    .update(patch)
    .eq("id", idNum)
    .select("*")
    .single();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data });
}

/** DELETE /api/admin/cdk-dealers/[id] — hard delete a CDK dealer row. */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const idNum = parseInt(params.id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("cdk_dealers").delete().eq("id", idNum);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
