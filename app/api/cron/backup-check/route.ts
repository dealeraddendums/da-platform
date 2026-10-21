import { NextRequest, NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { checkBackupFreshness, sendMissingBackupAlert } from "@/lib/backup-report";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/backup-check (X-Cron-Secret) — daily watchdog for the nightly
 * Supabase backup (EasyCron 07:00 PT, after the 02:00 run). Emails
 * "[DA Backup] MISSING …" when no backup object in s3://da-platform-backups is
 * newer than 36 h. A healthy run reports itself (lib/backup-report.ts), so this
 * stays silent unless something is wrong. `?dry=1` checks without emailing.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const s3 = new S3Client({
    region: process.env.BACKUP_BUCKET_REGION ?? "us-west-1",
    credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! },
  });
  const bucket = process.env.BACKUP_BUCKET ?? "da-platform-backups";
  try {
    const f = await checkBackupFreshness(s3, bucket);
    const dry = req.nextUrl.searchParams.get("dry") === "1";
    if (!f.fresh && !dry) await sendMissingBackupAlert(f);
    console.log(`[backup-check] ${f.fresh ? "fresh" : "MISSING"} · newest ${f.newest ?? "none"} · ${f.objects} objects${dry ? " (dry run)" : ""}`);
    return NextResponse.json({ ok: true, ...f, alerted: !f.fresh && !dry });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[backup-check] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
