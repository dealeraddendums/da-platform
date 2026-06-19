import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const DOC_TYPES = new Set(["addendum", "infosheet", "buyers_guide"]);

/**
 * GET /api/starter-templates/[id] — full starter row incl. template_json.
 * Any authenticated user (the Builder loads the layout to clone/edit).
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // starter_templates is not in the generated Database types yet; cast like other
  // newer-table routes (account_closures, billing_sync_errors, …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdb = admin as any;
  const { data, error: dbErr } = await sdb
    .from("starter_templates")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Starter layout not found" }, { status: 404 });
  return NextResponse.json({ data });
}

interface StarterPatch {
  name?: string;
  doc_type?: string;
  paper?: string;
  template_json?: Record<string, unknown>;
  sort_order?: number;
}

/**
 * PATCH /api/starter-templates/[id] — super_admin only. Accepts any subset of
 * { name, doc_type, paper, template_json, sort_order }.
 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  let body: StarterPatch;
  try { body = (await req.json()) as StarterPatch; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.name !== undefined) {
    if (!body.name.trim()) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = body.name.trim();
  }
  if (body.doc_type !== undefined) {
    if (!DOC_TYPES.has(body.doc_type)) return NextResponse.json({ error: "invalid doc_type" }, { status: 400 });
    patch.doc_type = body.doc_type;
  }
  if (body.paper !== undefined) {
    if (!body.paper.trim()) return NextResponse.json({ error: "paper cannot be empty" }, { status: 400 });
    patch.paper = body.paper;
  }
  if (body.template_json !== undefined) patch.template_json = body.template_json;
  if (body.sort_order !== undefined) patch.sort_order = body.sort_order;

  const admin = createAdminSupabaseClient();
  // starter_templates is not in the generated Database types yet; cast like other
  // newer-table routes (account_closures, billing_sync_errors, …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdb = admin as any;
  const { data, error: upErr } = await sdb
    .from("starter_templates")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ data });
}

/**
 * DELETE /api/starter-templates/[id] — super_admin only.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // starter_templates is not in the generated Database types yet; cast like other
  // newer-table routes (account_closures, billing_sync_errors, …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdb = admin as any;
  const { error: delErr } = await sdb
    .from("starter_templates")
    .delete()
    .eq("id", params.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
