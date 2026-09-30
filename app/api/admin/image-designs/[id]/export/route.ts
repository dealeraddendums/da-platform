import { NextRequest, NextResponse } from "next/server";
import { builderDb, requireImageBuilder } from "@/lib/image-builder/access";
import { audit, checkExport, saveToLibrary } from "@/lib/image-builder/server";
import { isImageType } from "@/lib/image-builder/spec";

/**
 * POST /api/admin/image-designs/[id]/export — "Save to Image Library".
 * multipart: file (PNG rendered in the browser from design_json).
 * Enforces the exact spec for the design's image type (dimensions, 150 DPI
 * pHYs, size) and rejects anything else. Writes a NEW Image Library entry —
 * never overwrites an existing PNG.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireImageBuilder();
  if (error) return error;

  const db = builderDb();
  const { data: design } = await db
    .from("image_designs").select("id, name, image_type").eq("id", params.id).maybeSingle();
  if (!design) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isImageType(design.image_type)) return NextResponse.json({ error: "Bad image type" }, { status: 500 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Invalid form data" }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  const bytes = new Uint8Array(await file.arrayBuffer());

  const bad = checkExport(bytes, design.image_type);
  if (bad) return NextResponse.json({ error: bad }, { status: 422 });

  const lib = await saveToLibrary(bytes, design.image_type, design.name, claims.sub);
  await db.from("image_designs").update({ exported_image_id: lib.id }).eq("id", params.id);
  audit(claims.sub, "image_design_exported", { design_id: params.id, image_library_id: lib.id, bucket: lib.bucket, bytes: bytes.length });
  return NextResponse.json({ data: lib }, { status: 201 });
}
