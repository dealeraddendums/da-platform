import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ALLOWED_BUCKETS: Record<string, { maxMB: number }> = {
  "new-infobox-images": { maxMB: 5 },
  "new-addendum-backgrounds": { maxMB: 5 },
  "new-infosheet-backgrounds": { maxMB: 10 },
};

const REGION = process.env.AWS_REGION || "us-east-1";
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

/** POST /api/admin/image-library/upload — super_admin only */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string | null)?.trim();

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!bucket || !ALLOWED_BUCKETS[bucket]) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed" }, { status: 422 });
  }

  const maxBytes = ALLOWED_BUCKETS[bucket].maxMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `File must be under ${ALLOWED_BUCKETS[bucket].maxMB} MB` },
      { status: 422 }
    );
  }

  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${Date.now()}_${cleanName}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: file.type,
    })
  );

  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  return NextResponse.json({ url, key }, { status: 201 });
}
