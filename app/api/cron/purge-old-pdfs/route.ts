import { NextRequest, NextResponse } from "next/server";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createAdminSupabaseClient } from "@/lib/db";

const BUCKET = "dealer-addendums";
const BATCH_SIZE = 100;

function getS3Client(): S3Client {
  return new S3Client({
    region: "us-west-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * POST /api/cron/purge-old-pdfs
 * Deletes S3 PDF objects for addendum_data rows older than 12 months,
 * then nulls out the s3_key so the record is kept but the file is gone.
 * Protected by x-cron-secret header.
 * Schedule: 0 3 1 * * (3 AM UTC on the 1st of each month)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();
  const s3 = getS3Client();

  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const cutoff = twelveMonthsAgo.toISOString();

  let totalDeleted = 0;
  let totalFailed = 0;
  const errors: string[] = [];

  // Process in batches until no rows remain
  while (true) {
    const { data: rows, error: fetchErr } = await admin
      .from("addendum_data")
      .select("id, s3_key")
      .not("s3_key", "is", null)
      .lt("printed_at", cutoff)
      .limit(BATCH_SIZE);

    if (fetchErr) {
      console.error("[purge-old-pdfs] DB fetch error:", fetchErr.message);
      errors.push(`DB fetch error: ${fetchErr.message}`);
      break;
    }

    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const key = row.s3_key as string;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

        const { error: updateErr } = await admin
          .from("addendum_data")
          .update({ s3_key: null })
          .eq("id", row.id as string);

        if (updateErr) {
          console.error(`[purge-old-pdfs] Failed to null s3_key for id=${row.id}:`, updateErr.message);
          errors.push(`id=${row.id} update failed: ${updateErr.message}`);
          totalFailed++;
        } else {
          totalDeleted++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[purge-old-pdfs] S3 delete failed for key=${key}:`, msg);
        errors.push(`key=${key}: ${msg}`);
        totalFailed++;
      }
    }

    // If we got fewer than BATCH_SIZE rows, we've processed everything
    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[purge-old-pdfs] PDF purge complete: deleted ${totalDeleted} files, failed ${totalFailed} files`);

  return NextResponse.json({ deleted: totalDeleted, failed: totalFailed, errors });
}
