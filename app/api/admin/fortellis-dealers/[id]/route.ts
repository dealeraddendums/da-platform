import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/** PATCH /api/admin/fortellis-dealers/[id] — edit a Fortellis dealer connection. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.dealer_name === "string") patch.dealer_name = body.dealer_name.trim();
  if (typeof body.subscription_id === "string") patch.subscription_id = body.subscription_id.trim();
  if ("web_id" in body) patch.web_id = (String(body.web_id ?? "").trim() || null);
  if ("dealer_code" in body) patch.dealer_code = (String(body.dealer_code ?? "").trim() || null);
  if ("dealer_id" in body) patch.dealer_id = (String(body.dealer_id ?? "").trim() || null);
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.is_new === "boolean") patch.is_new = body.is_new;
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("fortellis_dealers")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (dbErr) {
    const msg = /duplicate|unique/i.test(dbErr.message)
      ? "A dealer with that Subscription-Id already exists"
      : dbErr.message;
    return NextResponse.json({ error: msg }, { status: 400 });
  }
  return NextResponse.json({ data });
}

/** DELETE /api/admin/fortellis-dealers/[id] — remove a Fortellis dealer connection. */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("fortellis_dealers").delete().eq("id", id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
