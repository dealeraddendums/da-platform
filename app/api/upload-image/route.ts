import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { resolveDeleteContext, isDeletableKey, findImageUsage, RAW_IMAGE_BUCKETS, UNOWNED_BUCKETS } from "@/lib/raw-image-delete";

const ALLOWED_BUCKETS = new Set([
  "new-addendum-backgrounds",
  "new-infosheet-backgrounds",
  "new-dealer-logos",
  "addendum-product-images",
  "new-infobox-images",
]);

// Roles permitted to upload images. Allowlist — anything not in this set
// gets a 403. Previously this was a denylist (rejected dealer_user /
// dealer_restricted) which was functionally equivalent but harder to
// audit, and any unexpected role string fell through as "allowed".
// group_user (regional manager) is included for dealer-context parity (option
// images, custom-size backgrounds); the consuming routes scope by dealer.
const UPLOAD_ROLES = new Set(["super_admin", "group_admin", "dealer_admin", "group_user"]);

const REGION = process.env.AWS_REGION || "us-east-1";
const MAX_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/svg+xml"];

function getClient() {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/** GET /api/upload-image?bucket=X&prefix=Y — list images */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const bucket = searchParams.get("bucket");
  const prefix = searchParams.get("prefix") ?? undefined;

  if (!bucket || !ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const s3 = getClient();
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 200,
  }));

  // `deletable` is decided HERE, from resolved claims — the picker only renders
  // the control, it never decides who may delete (and DELETE re-checks anyway).
  const ctx = resolveDeleteContext(claims);
  const images = (result.Contents ?? [])
    .filter(obj => obj.Key && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(obj.Key))
    .map(obj => ({
      key: obj.Key!,
      url: `https://${bucket}.s3.${REGION}.amazonaws.com/${obj.Key!}`,
      size: obj.Size ?? 0,
      deletable: isDeletableKey(bucket, obj.Key!, ctx),
    }));

  return NextResponse.json({ images });
}

/** POST /api/upload-image — upload image to S3 bucket */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!UPLOAD_ROLES.has(claims.role)) {
    // Log the resolved role + sub so a 403 reported by a user-facing
    // "dealer_admin" can be diagnosed quickly (claims.role here comes from
    // profiles.role, not the JWT app_metadata). A real dealer_admin should
    // never land here — if they do, their profiles row is the thing to
    // check, not this route.
    console.warn(`[upload-image] denied — role=${claims.role} sub=${claims.sub} email=${claims.email}`);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // This route writes to a caller-supplied keyPrefix (no per-dealer resolution),
  // so a group_user (regional manager) may use it ONLY while switched into a
  // tag-verified dealer (active_dealer_id is set by the in-group+tag-checked
  // switch). The consuming routes (custom-sizes, options) re-authorize the
  // dealer via authorizeDealerAction before attaching the image to any record.
  if (claims.role === "group_user" && !claims.active_dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try { formData = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string | null)?.trim();
  const keyPrefix = (formData.get("keyPrefix") as string | null)?.trim() ?? "";

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!bucket || !ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed" }, { status: 422 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "File must be under 5 MB" }, { status: 422 });
  }

  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const prefix = keyPrefix ? `${keyPrefix}/`.replace(/\/+/g, "/") : "";
  const key = `${prefix}${Date.now()}_${cleanName}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: file.type,
  }));

  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  return NextResponse.json({ url, key }, { status: 201 });
}

/**
 * DELETE /api/upload-image?bucket=X&key=Y[&force=1]
 *
 * Permanently removes a raw S3 object. Ownership comes from lib/raw-image-delete
 * (server-resolved claims vs. the key prefix) — never from anything the client
 * sends. Without ?force=1 an in-use image returns 409 with the list of things
 * referencing it, so the UI can warn before destroying it.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const bucket = req.nextUrl.searchParams.get("bucket")?.trim() ?? "";
  const key = req.nextUrl.searchParams.get("key")?.trim() ?? "";
  const force = req.nextUrl.searchParams.get("force") === "1";

  if (!RAW_IMAGE_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }
  if (!key || key.includes("..")) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }

  const ctx = resolveDeleteContext(claims);
  if (!isDeletableKey(bucket, key, ctx)) {
    console.warn(`[upload-image] delete denied — role=${claims.role} sub=${claims.sub} bucket=${bucket} key=${key}`);
    return NextResponse.json({
      error: UNOWNED_BUCKETS.has(bucket)
        ? "These images are shared across dealers and can only be removed by DealerAddendums support."
        : "You can only delete images you uploaded.",
    }, { status: 403 });
  }

  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  if (!force) {
    let usedBy: string[] = [];
    try {
      usedBy = await findImageUsage(url);
    } catch (err) {
      // A usage-scan failure must not block the operator; the confirm dialog
      // simply can't list references. Never treat it as "not in use" silently.
      console.error("[upload-image] usage scan failed:", err instanceof Error ? err.message : err);
      return NextResponse.json({ error: "Could not check whether this image is in use — try again." }, { status: 503 });
    }
    if (usedBy.length > 0) {
      return NextResponse.json({ error: "in_use", usedBy }, { status: 409 });
    }
  }

  try {
    await s3Delete(bucket, key);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Delete failed" }, { status: 500 });
  }
  console.log(`[upload-image] deleted bucket=${bucket} key=${key} by=${claims.sub} role=${claims.role} force=${force}`);
  return NextResponse.json({ ok: true });
}

async function s3Delete(bucket: string, key: string): Promise<void> {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
