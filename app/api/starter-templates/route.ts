import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const DOC_TYPES = new Set(["addendum", "infosheet", "buyers_guide"]);

/**
 * GET /api/starter-templates?doc_type=
 * Platform starter layouts — list view (no template_json). Any authenticated
 * user (every dealer needs to list these for the +New picker). Ordered by
 * sort_order, then most-recently-updated.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const docType = req.nextUrl.searchParams.get("doc_type");
  const admin = createAdminSupabaseClient();
  // starter_templates is not in the generated Database types yet; cast like other
  // newer-table routes (account_closures, billing_sync_errors, …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdb = admin as any;
  let q = sdb
    .from("starter_templates")
    .select("id, name, doc_type, paper, sort_order, updated_at")
    .order("sort_order", { ascending: true })
    .order("updated_at", { ascending: false });
  if (docType) {
    if (!DOC_TYPES.has(docType)) return NextResponse.json({ error: "invalid doc_type" }, { status: 400 });
    q = q.eq("doc_type", docType);
  }
  const { data, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

interface StarterBody {
  name?: string;
  doc_type?: string;
  paper?: string;
  template_json?: Record<string, unknown>;
  sort_order?: number;
}

/**
 * POST /api/starter-templates — create a starter layout. super_admin only.
 * Body: { name, doc_type, paper, template_json, sort_order? }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: StarterBody;
  try { body = (await req.json()) as StarterBody; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!body.doc_type || !DOC_TYPES.has(body.doc_type)) {
    return NextResponse.json({ error: "doc_type must be addendum, infosheet, or buyers_guide" }, { status: 400 });
  }
  if (!body.paper?.trim()) return NextResponse.json({ error: "paper is required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // starter_templates is not in the generated Database types yet; cast like other
  // newer-table routes (account_closures, billing_sync_errors, …).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdb = admin as any;
  const { data, error: insErr } = await sdb
    .from("starter_templates")
    .insert({
      name,
      doc_type: body.doc_type,
      paper: body.paper,
      template_json: body.template_json ?? {},
      sort_order: typeof body.sort_order === "number" ? body.sort_order : 0,
      created_by: claims.sub,
    })
    .select()
    .single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  return NextResponse.json({ data });
}
