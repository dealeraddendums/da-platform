import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
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

/** GET /api/admin/image-library/[bucket] — list all images in a bucket */
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

  const images = (result.Contents ?? [])
    .filter((obj) => obj.Key && /\.(png|jpg|jpeg|gif|webp)$/i.test(obj.Key))
    .map((obj) => ({
      key: obj.Key!,
      url: `https://${bucket}.s3.${REGION}.amazonaws.com/${obj.Key!}`,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified?.toISOString() ?? null,
    }));

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

  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return NextResponse.json({ ok: true });
}
