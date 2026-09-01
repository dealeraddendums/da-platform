import { NextRequest, NextResponse } from "next/server";
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

const BUCKET = "dealer-addendums";
const DELETE_CONCURRENCY = 25;

const s3 = new S3Client({
  region: "us-west-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

async function runPurgeJob(): Promise<void> {
  const admin = createAdminSupabaseClient();

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  let totalScanned = 0;
  let totalDeleted = 0;
  let totalFailed = 0;

  let continuationToken: string | undefined;

  do {
    const listRes = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
    }));

    const objects = listRes.Contents ?? [];
    totalScanned += objects.length;

    const stale = objects.filter(
      o => o.Key && o.LastModified && o.LastModified < cutoff
    ) as { Key: string; LastModified: Date }[];

    for (let i = 0; i < stale.length; i += DELETE_CONCURRENCY) {
      const chunk = stale.slice(i, i + DELETE_CONCURRENCY);

      const settled = await Promise.allSettled(
        chunk.map(async ({ Key }) => {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));

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
          console.error(`[purge-old-pdfs] Delete failed key=${chunk[j].Key}:`, msg);
        }
      }
    }

    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  console.log(
    `[purge-old-pdfs] PDF purge complete: scanned ${totalScanned} files, deleted ${totalDeleted} files, failed ${totalFailed} files`
  );

  // Fortellis certification logs: retain >=60 days, purge >90 days.
  try {
    const logCutoff = new Date();
    logCutoff.setDate(logCutoff.getDate() - 90);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: logErr } = await (admin as any)
      .from("fortellis_api_log")
      .delete()
      .lt("at", logCutoff.toISOString());
    if (logErr) console.error("[purge-old-pdfs] fortellis_api_log purge failed:", logErr.message);
    else console.log("[purge-old-pdfs] fortellis_api_log rows older than 90 days purged");
  } catch (err) {
    console.error("[purge-old-pdfs] fortellis_api_log purge error:", err instanceof Error ? err.message : err);
  }

  // VIN decode usage logs (migration 151): keep 24 months.
  try {
    const decodeCutoff = new Date();
    decodeCutoff.setMonth(decodeCutoff.getMonth() - 24);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: decErr } = await (admin as any)
      .from("vin_decode_log")
      .delete()
      .lt("at", decodeCutoff.toISOString());
    if (decErr) console.error("[purge-old-pdfs] vin_decode_log purge failed:", decErr.message);
    else console.log("[purge-old-pdfs] vin_decode_log rows older than 24 months purged");
  } catch (err) {
    console.error("[purge-old-pdfs] vin_decode_log purge error:", err instanceof Error ? err.message : err);
  }
}

/**
 * POST /api/cron/purge-old-pdfs
 * Returns 200 immediately after auth, then runs the S3 scan/delete in the background.
 * Schedule: 0 3 1 * * (3 AM UTC, 1st of each month)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  runPurgeJob().catch(err =>
    console.error("[purge-old-pdfs] Purge job error:", err instanceof Error ? err.message : err)
  );

  return NextResponse.json({ status: "started", message: "Purge job running in background" });
}
