import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

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
const UPLOAD_ROLES = new Set(["super_admin", "group_admin", "dealer_admin"]);

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
  const { error } = await requireAuth();
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

  const images = (result.Contents ?? [])
    .filter(obj => obj.Key && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(obj.Key))
    .map(obj => ({
      key: obj.Key!,
      url: `https://${bucket}.s3.${REGION}.amazonaws.com/${obj.Key!}`,
      size: obj.Size ?? 0,
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
