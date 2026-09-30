import { NextRequest, NextResponse } from "next/server";
import { builderDb, requireImageBuilder } from "@/lib/image-builder/access";
import { audit, writeVersion } from "@/lib/image-builder/server";

/**
 * POST /api/admin/image-designs/[id]/restore  { version_no }
 * Makes an old version current. History is append-only: the restore is itself
 * saved as a NEW version (a copy of the old JSON), so nothing is ever lost.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireImageBuilder();
  if (error) return error;
  const body = await req.json().catch(() => ({}));
  const n = Number(body?.version_no);
  if (!Number.isInteger(n) || n < 1) return NextResponse.json({ error: "version_no required" }, { status: 400 });

  const db = builderDb();
  const { data: cur } = await db.from("image_designs").select("id, is_template").eq("id", params.id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (cur.is_template) return NextResponse.json({ error: "Starter templates are read-only" }, { status: 409 });

  const { data: v } = await db
    .from("image_design_versions").select("design_json").eq("design_id", params.id).eq("version_no", n).maybeSingle();
  if (!v) return NextResponse.json({ error: "Version not found" }, { status: 404 });

  const { error: upErr } = await db
    .from("image_designs").update({ design_json: v.design_json, updated_at: new Date().toISOString() }).eq("id", params.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  const newVersion = await writeVersion(params.id, v.design_json, claims.sub);
  audit(claims.sub, "image_design_restored", { design_id: params.id, restored_version: n, new_version: newVersion });
  return NextResponse.json({ design_json: v.design_json, version_no: newVersion, restored_from: n });
}
