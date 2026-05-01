import { NextResponse, type NextRequest } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * GET /api/dashboard/pdf-preview?dealer_id=UUID&printed_at=ISO
 * super_admin only. Returns a fresh 1-hour signed URL for the PDF, suitable
 * for inline rendering in an iframe.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const params = req.nextUrl.searchParams;
  const dealerUuid = params.get("dealer_id");
  const printedAt = params.get("printed_at");

  if (!dealerUuid || !printedAt) {
    return NextResponse.json({ error: "dealer_id and printed_at required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // ±90 second window — addendum_data.printed_at is set after print_history.created_at
  const ts = new Date(printedAt);
  if (isNaN(ts.getTime())) {
    return NextResponse.json({ error: "invalid printed_at" }, { status: 400 });
  }
  const tsMin = new Date(ts.getTime() - 90_000).toISOString();
  const tsMax = new Date(ts.getTime() + 90_000).toISOString();

  const { data } = await admin
    .from("addendum_data")
    .select("s3_key")
    .eq("dealer_id", dealerUuid)
    .gte("printed_at", tsMin)
    .lte("printed_at", tsMax)
    .not("s3_key", "is", null)
    .order("printed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ s3_key: string }>();

  const s3Key = data?.s3_key ?? null;
  if (!s3Key) {
    return NextResponse.json({ url: null });
  }

  const s3 = new S3Client({
    region: "us-west-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: "dealer-addendums",
      Key: s3Key,
      ResponseContentDisposition: "inline",
      ResponseContentType: "application/pdf",
    }),
    { expiresIn: 3600 },
  );

  return NextResponse.json({ url });
}
