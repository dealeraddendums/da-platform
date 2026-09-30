import { NextRequest, NextResponse } from "next/server";
import { builderDb, requireImageBuilder } from "@/lib/image-builder/access";

/** GET /api/admin/image-designs/[id]/versions/[versionNo] — one version's design_json. */
export async function GET(_req: NextRequest, { params }: { params: { id: string; versionNo: string } }): Promise<NextResponse> {
  const { error } = await requireImageBuilder();
  if (error) return error;
  const n = Number(params.versionNo);
  if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: "Invalid version" }, { status: 400 });
  const { data } = await builderDb()
    .from("image_design_versions").select("version_no, design_json, saved_at")
    .eq("design_id", params.id).eq("version_no", n).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data });
}
