import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { uploadLogo } from "@/lib/s3-upload";
import sharp from "sharp";

type Params = { params: { id: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/svg+xml": "svg",
};
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * GET /api/dealers/[id]/logo
 * Returns current logo_url. [id] may be UUID or text dealer_id.
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("dealer_id, logo_url")
    .eq(UUID_RE.test(params.id) ? "id" : "dealer_id", params.id)
    .maybeSingle();

  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
  if (isDealer && claims.dealer_id !== dealer.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({ logo_url: dealer.logo_url ?? null });
}

/**
 * POST /api/dealers/[id]/logo
 * Accepts multipart/form-data with a `file` field.
 * [id] may be the UUID (dealers.id) or the text dealer_id (dealers.dealer_id).
 * Uploads to new-dealer-logos S3 bucket, updates dealers.logo_url.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, logo_url")
    .eq(UUID_RE.test(params.id) ? "id" : "dealer_id", params.id)
    .maybeSingle();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
  if (isDealer && claims.dealer_id !== dealer.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return NextResponse.json({ error: "Only PNG, JPG, or SVG files are allowed" }, { status: 400 });
  }

  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be under 2 MB" }, { status: 400 });
  }

  const rawBuffer = Buffer.from(await file.arrayBuffer());
  let buffer: Buffer;

  // Resize raster images to max 800×400 px, PNG output for quality/transparency
  if (file.type !== "image/svg+xml") {
    const resized = await sharp(rawBuffer)
      .resize({ width: 800, height: 400, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
    buffer = Buffer.from(resized);
  } else {
    buffer = rawBuffer;
  }

  // Always store as .png for raster (consistent URL, no format confusion)
  const finalExt = file.type === "image/svg+xml" ? "svg" : "png";
  const finalContentType = file.type === "image/svg+xml" ? "image/svg+xml" : "image/png";
  const s3Key = `${dealer.dealer_id}/logo.${finalExt}`;

  let logoUrl: string;
  try {
    logoUrl = await uploadLogo(buffer, s3Key, finalContentType);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }

  const { error: patchErr } = await admin
    .from("dealers")
    .update({ logo_url: logoUrl })
    .eq("id", dealer.id);

  if (patchErr) {
    return NextResponse.json({ error: patchErr.message }, { status: 500 });
  }

  return NextResponse.json({ logo_url: logoUrl });
}

/**
 * DELETE /api/dealers/[id]/logo
 * Clears dealers.logo_url (does not delete S3 object).
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id")
    .eq(UUID_RE.test(params.id) ? "id" : "dealer_id", params.id)
    .maybeSingle();

  if (!dealer) {
    return NextResponse.json({ error: "Dealer not found" }, { status: 404 });
  }

  const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
  if (isDealer && claims.dealer_id !== dealer.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await admin.from("dealers").update({ logo_url: null }).eq("id", dealer.id);
  return NextResponse.json({ ok: true });
}
