import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCrmStaff } from "@/lib/crm/access";
import { putCrmObject } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";

const BUCKET_URL = "https://dealer-addendums.s3.us-west-1.amazonaws.com";

/**
 * POST /api/crm/email-images (multipart: file) — inline image for an email
 * template or signature. Email clients must fetch images from a public https
 * URL (Outlook blocks base64 data: URIs), so these are deliberately public:
 * crm/email-images/{uuid}.{ext} in the public-read dealer-addendums bucket.
 * PNG / JPEG / GIF ≤ 2 MB (no SVG — script risk, and Outlook won't show it).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "file required" }, { status: 400 });
  const ext = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as Record<string, string>)[file.type];
  if (!ext) return NextResponse.json({ error: "PNG, JPEG or GIF only" }, { status: 400 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "Image is larger than 2 MB" }, { status: 400 });
  const key = `crm/email-images/${randomUUID()}.${ext}`;
  await putCrmObject(key, Buffer.from(await file.arrayBuffer()), file.type);
  return NextResponse.json({ ok: true, url: `${BUCKET_URL}/${key}` });
}
