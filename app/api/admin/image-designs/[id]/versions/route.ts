import { NextRequest, NextResponse } from "next/server";
import { builderDb, designInScope, requireBuilderScope } from "@/lib/image-builder/access";

/** GET /api/admin/image-designs/[id]/versions — version history, newest first (no design_json). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { scope, error } = await requireBuilderScope(req);
  if (error) return error;
  const db = builderDb();
  const { data: cur } = await db.from("image_designs").select("group_id, dealer_uuid, is_template").eq("id", params.id).maybeSingle();
  if (!cur || !designInScope(cur, scope)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data, error: dbErr } = await db
    .from("image_design_versions")
    .select("id, version_no, saved_by, saved_at")
    .eq("design_id", params.id)
    .order("version_no", { ascending: false })
    .range(0, 999);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  const ids = Array.from(new Set((data ?? []).map((v: { saved_by: string | null }) => v.saved_by).filter(Boolean)));
  const names = new Map<string, string>();
  if (ids.length) {
    const { data: people } = await db.from("profiles").select("id, full_name, email").in("id", ids);
    for (const p of people ?? []) names.set(p.id, p.full_name || p.email);
  }
  return NextResponse.json({
    data: (data ?? []).map((v: { saved_by: string | null }) => ({ ...v, saved_by_name: v.saved_by ? names.get(v.saved_by) ?? null : null })),
  });
}
