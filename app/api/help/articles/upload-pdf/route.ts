import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { HELP_MEDIA_BUCKET, HELP_MEDIA_PREFIX } from "@/lib/help-media";

// Same public-read bucket + help/ key prefix as the image and video uploads.
const REGION = process.env.AWS_REGION || "us-east-1";
const MAX_BYTES = 20 * 1024 * 1024; // 20 MB — a guide, not a manual archive

/** POST /api/help/articles/upload-pdf — super_admin only (the support team). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let formData: FormData;
  try { formData = await req.formData(); } catch { return NextResponse.json({ error: "Invalid form data" }, { status: 400 }); }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (file.type !== "application/pdf") return NextResponse.json({ error: "Only PDF files allowed" }, { status: 422 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "PDF must be under 20 MB" }, { status: 422 });

  const buffer = Buffer.from(await file.arrayBuffer());
  // Check the magic bytes, not just the browser-supplied Content-Type: the
  // dealer page frames this object, so "it says PDF" isn't good enough.
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ error: "That file isn't a PDF" }, { status: 422 });
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${HELP_MEDIA_PREFIX}${Date.now()}_${safeName}`;

  const s3 = new S3Client({
    region: REGION,
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  });
  try {
    await s3.send(new PutObjectCommand({
      Bucket: HELP_MEDIA_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "application/pdf",
      // Without this S3 serves the object as a download for some clients; the
      // dealer page frames it, so it must render inline.
      ContentDisposition: "inline",
    }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
  }

  const url = `https://${HELP_MEDIA_BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
  return NextResponse.json({ url }, { status: 201 });
}
