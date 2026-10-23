import { NextRequest, NextResponse } from "next/server";
import { S3Client } from "@aws-sdk/client-s3";
import { checkBackupFreshness, evaluateBackupHealth, readLatestReport, sendBackupHealthAlert } from "@/lib/backup-report";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/backup-check (X-Cron-Secret) — daily watchdog for the nightly
 * Supabase backup (EasyCron 07:00 PT, after the 02:00 run). Emails
 * "[DA Backup] MISSING …" when no backup object in s3://da-platform-backups is
 * newer than 36 h, or "[DA Backup] INCOMPLETE …" when objects exist but no run
 * report finished in 36 h (the run was killed). A healthy run reports itself
 * (lib/backup-report.ts), so this stays silent unless something is wrong.
 * `?dry=1` checks without emailing.
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
    const now = new Date();
    const [f, report] = await Promise.all([checkBackupFreshness(s3, bucket, now), readLatestReport(s3, bucket)]);
    const h = evaluateBackupHealth(f, report, now);
    const dry = req.nextUrl.searchParams.get("dry") === "1";
    if (h.state !== "ok" && !dry) await sendBackupHealthAlert(h);
    console.log(`[backup-check] ${h.state.toUpperCase()} · newest object ${h.newest ?? "none"} · ${h.objects} objects · last report ${report ? `${report.date} ${report.status}` : "none"}${dry ? " (dry run)" : ""}`);
    return NextResponse.json({ ok: true, ...h, alerted: h.state !== "ok" && !dry });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[backup-check] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
