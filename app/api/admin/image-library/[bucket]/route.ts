import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

type Params = { params: { bucket: string } };

const ALLOWED_BUCKETS = new Set([
  "new-infobox-images",
  "new-addendum-backgrounds",
  "new-infosheet-backgrounds",
]);

const REGION = process.env.AWS_REGION || "us-east-1";

function getClient() {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function cleanDisplayName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, ""); // strip extension
  return base.replace(/^\d{10,}_/, ""); // strip timestamp prefix
}

/** GET /api/admin/image-library/[bucket] — list all images, auto-populating image_library metadata */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const bucket = params.bucket;
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const s3 = getClient();
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 500 })
  );

  const s3Objects = (result.Contents ?? [])
    // Root-level keys only. Group/dealer-scoped images live under
    // `group/…` / `dealer/…` prefixes and must never appear in the platform
    // listing (which would re-tag them as platform on auto-populate).
    .filter((obj) => obj.Key && !obj.Key.includes("/") && /\.(png|jpg|jpeg|gif|webp)$/i.test(obj.Key))
    .map((obj) => ({
      key: obj.Key!,
      url: `https://${bucket}.s3.${REGION}.amazonaws.com/${obj.Key!}`,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? null,
    }));

  const admin = createAdminSupabaseClient();

  // Fetch existing DB records for this bucket
  const { data: dbRows } = await admin
    .from("image_library")
    .select("id, s3_key, display_name")
    .eq("bucket", bucket);

  const dbMap = new Map((dbRows ?? []).map((r) => [r.s3_key as string, r as { id: string; s3_key: string; display_name: string }]));

  // Auto-populate missing records
  const missing = s3Objects.filter((obj) => !dbMap.has(obj.key));
  if (missing.length > 0) {
    const inserts = missing.map((obj) => ({
      bucket,
      s3_key: obj.key,
      url: obj.url,
      display_name: cleanDisplayName(obj.key.split("/").pop() ?? obj.key),
      file_size: obj.size,
    }));
    const { data: inserted } = await admin
      .from("image_library")
      .upsert(inserts, { onConflict: "bucket,s3_key" })
      .select("id, s3_key, display_name");
    for (const row of inserted ?? []) {
      dbMap.set(row.s3_key as string, row as { id: string; s3_key: string; display_name: string });
    }
  }

  // Merge S3 metadata with DB display_name, sorted by display_name
  const images = s3Objects
    .map((obj) => {
      const dbRow = dbMap.get(obj.key);
      return {
        ...obj,
        id: dbRow?.id ?? null,
        display_name: dbRow?.display_name ?? cleanDisplayName(obj.key.split("/").pop() ?? obj.key),
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  return NextResponse.json({ images });
}

/** DELETE /api/admin/image-library/[bucket]?key=path/to/file.png */
export async function DELETE(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const bucket = params.bucket;
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const key = req.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json({ error: "key required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  await Promise.all([
    getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })),
    admin.from("image_library").delete().eq("bucket", bucket).eq("s3_key", key),
  ]);

  return NextResponse.json({ ok: true });
}
