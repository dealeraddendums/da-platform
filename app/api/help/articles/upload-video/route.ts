import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Same public-read bucket + help/ key prefix as image uploads. Short clips only.
const BUCKET = "new-infobox-images";
const REGION = process.env.AWS_REGION || "us-east-1";
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — short demo clips, not full videos
const ALLOWED_TYPES = ["video/mp4", "video/webm"];

/** POST /api/help/articles/upload-video — super_admin only (the support team). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let formData: FormData;
  try { formData = await req.formData(); } catch { return NextResponse.json({ error: "Invalid form data" }, { status: 400 }); }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "Only MP4 or WebM allowed" }, { status: 422 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Video must be under 25 MB" }, { status: 422 });

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `help/${Date.now()}_${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const s3 = new S3Client({
    region: REGION,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  });
  try {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: file.type }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }

  const url = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  return NextResponse.json({ url }, { status: 201 });
}
