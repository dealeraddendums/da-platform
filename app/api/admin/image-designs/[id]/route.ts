import { NextRequest, NextResponse } from "next/server";
import { builderDb, requireImageBuilder } from "@/lib/image-builder/access";
import { audit, DESIGN_LIST_COLUMNS, writeVersion } from "@/lib/image-builder/server";
import { validateDesign, MAX_DESIGN_JSON_BYTES, type DesignDoc } from "@/lib/image-builder/spec";

type Params = { params: { id: string } };

/** GET /api/admin/image-designs/[id] — full design incl. design_json + latest version no. */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireImageBuilder();
  if (error) return error;
  const db = builderDb();
  const { data, error: dbErr } = await db
    .from("image_designs")
    .select(`${DESIGN_LIST_COLUMNS}, design_json, exported:image_library!image_designs_exported_image_id_fkey(id, url, display_name, bucket), replaces:image_library!image_designs_replaces_image_id_fkey(id, url, display_name, bucket)`)
    .eq("id", params.id)
    .maybeSingle();
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: last } = await db
    .from("image_design_versions").select("version_no").eq("design_id", params.id)
    .order("version_no", { ascending: false }).limit(1).maybeSingle();
  return NextResponse.json({ data: { ...data, latest_version: last?.version_no ?? null } });
}

/**
 * PATCH /api/admin/image-designs/[id] — "Save design".
 * Body: { design_json?, name?, replaces_image_id? }. A design_json change writes
 * a new version row. Never touches the Image Library (that's the export route).
 * Starter templates are read-only — duplicate them to edit.
 */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireImageBuilder();
  if (error) return error;
  const raw = await req.text();
  if (raw.length > MAX_DESIGN_JSON_BYTES) return NextResponse.json({ error: "Design too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const db = builderDb();
  const { data: cur } = await db.from("image_designs").select("id, is_template").eq("id", params.id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (cur.is_template) {
    return NextResponse.json({ error: "Starter templates are read-only — use Duplicate & edit." }, { status: 409 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.design_json !== undefined) {
    const bad = validateDesign(body.design_json);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    patch.design_json = body.design_json;
  }
  if (body.name !== undefined) {
    const n = typeof body.name === "string" ? body.name.trim() : "";
    if (!n) return NextResponse.json({ error: "Name is required" }, { status: 400 });
    patch.name = n.slice(0, 200);
  }
  if (body.replaces_image_id !== undefined) {
    if (body.replaces_image_id !== null && typeof body.replaces_image_id !== "string") {
      return NextResponse.json({ error: "Invalid replaces_image_id" }, { status: 400 });
    }
    patch.replaces_image_id = body.replaces_image_id;
  }

  const { data: row, error: upErr } = await db
    .from("image_designs").update(patch).eq("id", params.id).select(DESIGN_LIST_COLUMNS).single();
  if (upErr || !row) return NextResponse.json({ error: upErr?.message ?? "Update failed" }, { status: 500 });

  let version: number | null = null;
  if (patch.design_json) {
    version = await writeVersion(params.id, patch.design_json as DesignDoc, claims.sub);
    audit(claims.sub, "image_design_saved", { design_id: params.id, version_no: version });
  }
  return NextResponse.json({ data: row, version_no: version });
}

/** DELETE /api/admin/image-designs/[id] — delete a design (never a template, never the library PNG). */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireImageBuilder();
  if (error) return error;
  const db = builderDb();
  const { data: cur } = await db.from("image_designs").select("id, is_template, name").eq("id", params.id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (cur.is_template) return NextResponse.json({ error: "Starter templates can't be deleted" }, { status: 409 });
  const { error: delErr } = await db.from("image_designs").delete().eq("id", params.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
  audit(claims.sub, "image_design_deleted", { design_id: params.id, name: cur.name });
  return NextResponse.json({ ok: true });
}
