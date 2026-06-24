import { NextResponse, type NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * GET /api/dashboard/pdf-preview?dealer_id=UUID&printed_at=ISO
 * super_admin (any dealer) or group_admin (dealers in their own group — the
 * white-label dashboard's Live Activity runs as a group_admin). Returns a fresh
 * 1-hour signed URL for the PDF, suitable for inline rendering in an iframe.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const dealerUuid = params.get("dealer_id");
  const printedAt = params.get("printed_at");

  if (!dealerUuid || !printedAt) {
    return NextResponse.json({ error: "dealer_id and printed_at required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // group_admin may only preview PDFs for dealers in their own group (same
  // scoping as /api/dashboard/recent-prints). super_admin: any dealer.
  if (claims.role === "group_admin") {
    const { data: d } = await admin
      .from("dealers")
      .select("group_id")
      .eq("id", dealerUuid)
      .maybeSingle<{ group_id: string | null }>();
    if (!d || !claims.group_id || d.group_id !== claims.group_id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

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
