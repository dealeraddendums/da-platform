import { NextRequest, NextResponse } from "next/server";
import { builderDb, designInScope, replacesImageAllowed, requireBuilderScope } from "@/lib/image-builder/access";
import { audit, DESIGN_LIST_COLUMNS, writeVersion } from "@/lib/image-builder/server";
import { isImageType, validateDesign, MAX_DESIGN_JSON_BYTES, type DesignDoc } from "@/lib/image-builder/spec";

// Image Builder designs (migration 163). Staff, or one group with ?group=<id>
// (migration 167) — see requireBuilderScope in lib/image-builder/access.ts.

const EMPTY_DOC: DesignDoc = { version: 1, background: "#ffffff", elements: [] };

/** GET /api/admin/image-designs — designs + starter templates (no design_json).
 *  Staff: platform designs + starters. ?group=: that group's designs only (no starters). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { scope, error } = await requireBuilderScope(req);
  if (error) return error;
  let q = builderDb()
    .from("image_designs")
    .select(`${DESIGN_LIST_COLUMNS}, exported:image_library!image_designs_exported_image_id_fkey(url, display_name), replaces:image_library!image_designs_replaces_image_id_fkey(url, display_name)`);
  q = scope.kind === "group" ? q.eq("group_id", scope.groupId).eq("is_template", false) : q.is("group_id", null);
  const { data, error: dbErr } = await q
    .order("is_template", { ascending: false })
    .order("updated_at", { ascending: false })
    .range(0, 999);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/**
 * POST /api/admin/image-designs — create a design.
 * Body: { name, image_type, design_json? } for a new design, or
 *       { from_id, name? } to duplicate an existing design/template.
 * Always writes version 1.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, scope, error } = await requireBuilderScope(req);
  if (error) return error;
  const raw = await req.text();
  if (raw.length > MAX_DESIGN_JSON_BYTES) return NextResponse.json({ error: "Design too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const db = builderDb();
  let imageType: unknown = body.image_type;
  let doc: unknown = body.design_json ?? EMPTY_DOC;
  let name = typeof body.name === "string" ? body.name.trim() : "";
  let replaces: unknown = body.replaces_image_id ?? null;

  if (typeof body.from_id === "string") {
    const { data: src } = await db
      .from("image_designs").select("image_type, name, design_json, replaces_image_id, group_id, is_template").eq("id", body.from_id).maybeSingle();
    // A group may only duplicate its own designs (no starters for groups).
    if (!src || !designInScope(src, scope)) return NextResponse.json({ error: "Source design not found" }, { status: 404 });
    imageType = src.image_type;
    doc = src.design_json;
    name = name || `${src.name} (copy)`;
    replaces = body.replaces_image_id !== undefined ? body.replaces_image_id : null;
  }

  if (!isImageType(imageType)) return NextResponse.json({ error: "Invalid image_type" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  const bad = validateDesign(doc);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  if (replaces !== null && typeof replaces !== "string") {
    return NextResponse.json({ error: "Invalid replaces_image_id" }, { status: 400 });
  }
  if (!(await replacesImageAllowed(replaces as string | null, scope))) {
    return NextResponse.json({ error: "That image isn't in this group's library" }, { status: 400 });
  }

  const { data: row, error: insErr } = await db
    .from("image_designs")
    .insert({
      image_type: imageType, name: name.slice(0, 200), design_json: doc,
      replaces_image_id: replaces, created_by: claims.sub, is_template: false, dealer_uuid: null,
      group_id: scope.kind === "group" ? scope.groupId : null,
    })
    .select(DESIGN_LIST_COLUMNS)
    .single();
  if (insErr || !row) return NextResponse.json({ error: insErr?.message ?? "Insert failed" }, { status: 500 });

  await writeVersion(row.id, doc as DesignDoc, claims.sub);
  audit(claims.sub, "image_design_created", { design_id: row.id, from_id: body.from_id ?? null, image_type: imageType, group_id: scope.kind === "group" ? scope.groupId : null });
  return NextResponse.json({ data: row }, { status: 201 });
}
