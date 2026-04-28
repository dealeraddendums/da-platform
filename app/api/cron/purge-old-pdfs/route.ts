import { NextRequest, NextResponse } from "next/server";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createAdminSupabaseClient } from "@/lib/db";

const BUCKET = "dealer-addendums";
const DELETE_CONCURRENCY = 25;

const s3 = new S3Client({
  region: "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

/**
 * POST /api/cron/purge-old-pdfs
 * S3-first: paginates all objects in dealer-addendums, deletes any with
 * LastModified older than 12 months. Also nulls s3_key in addendum_data
 * for each deleted key (cleanup only — never blocks deletion).
 * Schedule: 0 3 1 * * (3 AM UTC, 1st of each month)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminSupabaseClient();

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  let totalScanned = 0;
  let totalDeleted = 0;
  let totalFailed = 0;
  const errors: string[] = [];

  let continuationToken: string | undefined;

  do {
    // ── List one page of S3 objects (up to 1000) ─────────────────────────────
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }));

    const objects = listRes.Contents ?? [];
    totalScanned += objects.length;

    // ── Filter to objects older than 12 months ────────────────────────────────
    const stale = objects.filter(
      o => o.Key && o.LastModified && o.LastModified < cutoff
    ) as { Key: string; LastModified: Date }[];

    // ── Delete in parallel batches of DELETE_CONCURRENCY ─────────────────────
    for (let i = 0; i < stale.length; i += DELETE_CONCURRENCY) {
      const chunk = stale.slice(i, i + DELETE_CONCURRENCY);

      const settled = await Promise.allSettled(
        chunk.map(async ({ Key }) => {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));

          // Null out matching addendum_data row — cleanup only, non-blocking
          const { error: dbErr } = await admin
            .from("addendum_data")
            .update({ s3_key: null })
            .eq("s3_key", Key);
          if (dbErr) {
            console.error(`[purge-old-pdfs] DB cleanup failed for key=${Key}:`, dbErr.message);
          }
        })
      );

      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        if (result.status === "fulfilled") {
          totalDeleted++;
        } else {
          totalFailed++;
          const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          const key = chunk[j].Key;
          console.error(`[purge-old-pdfs] Delete failed key=${key}:`, msg);
          errors.push(`key=${key}: ${msg}`);
        }
      }
    }

    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log(
    `[purge-old-pdfs] PDF purge complete: scanned ${totalScanned} files, deleted ${totalDeleted} files, failed ${totalFailed} files`
  );

  return NextResponse.json({ deleted: totalDeleted, failed: totalFailed, scanned: totalScanned, errors });
}
