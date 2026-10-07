import { NextRequest, NextResponse } from "next/server";
import { builderDb, designInScope, requireBuilderScope } from "@/lib/image-builder/access";

/** GET /api/admin/image-designs/[id]/versions/[versionNo] — one version's design_json. */
export async function GET(req: NextRequest, { params }: { params: { id: string; versionNo: string } }): Promise<NextResponse> {
  const { scope, error } = await requireBuilderScope(req);
  if (error) return error;
  const { data: cur } = await builderDb().from("image_designs").select("group_id, is_template").eq("id", params.id).maybeSingle();
  if (!cur || !designInScope(cur, scope)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const n = Number(params.versionNo);
  if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  const { data } = await builderDb()
    .from("image_design_versions").select("version_no, design_json, saved_at")
    .eq("design_id", params.id).eq("version_no", n).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}
