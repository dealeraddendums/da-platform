// EasyCron registration (must be added manually after deploy):
//   Schedule: 0 9 5 * *    (monthly, 09:00 UTC on the 5th)
//   URL:      POST https://app.dealeraddendums.com/api/cron/chromedata-usage-report
//   Header:   x-cron-secret: <CRON_SECRET value from .env.production>

import { NextRequest, NextResponse } from "next/server";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { buildChromeDataReport } from "@/lib/chromedata-usage-report";
import { sendMandrillEmail } from "@/lib/mandrill";

/**
 * POST /api/cron/chromedata-usage-report
 *
 * Builds the monthly ChromeData vehicle-image usage report for the previous
 * calendar month (or ?month=YYYY-MM to override), uploads a copy to S3 for
 * the record, and emails the .xlsx to billing@chromedata.com via Mandrill.
 * Pass ?dry_run=1 to build and inspect the dealer list without sending or
 * archiving anything.
 *
 * Auth: x-cron-secret header must match CRON_SECRET. The Reports page
 * manual-trigger button calls the same route through the regular session,
 * so super_admin sessions are also allowed.
 *
 * Schedule (EasyCron): 0 9 5 * * — 9 AM on the 5th of each month. The
 * report covers the calendar month immediately prior, matching ChromeData's
 * billing cadence.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ChromeData report failed";
    console.error("[chromedata-usage-report] uncaught:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  // Two valid auth paths: the cron secret header, OR a super_admin session.
  // The latter lets the Reports page button reuse this endpoint.
  const cronSecret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  const cronOk = !!expected && cronSecret === expected;
  if (!cronOk) {
    // Lazy import to avoid auth dependency in the cron-only path.
    const { requireSuperAdmin } = await import("@/lib/auth");
    const { error } = await requireSuperAdmin();
    if (error) return error;
  }

  const monthOverride = req.nextUrl.searchParams.get("month");
  const report = await buildChromeDataReport(monthOverride);

  // ?dry_run=1 — build the report and return the dealer list WITHOUT emailing
  // ChromeData or archiving to S3. Added 2026-09-05 after the first automated
  // run emailed a wrong number ("Locations reported: 0"): the count is now
  // eyeballed before anything leaves the building.
  if (req.nextUrl.searchParams.get("dry_run") === "1") {
    return NextResponse.json({
      dry_run: true,
      month: report.month,
      dealers: report.rows.length,
      file: report.filename,
      by_platform: {
        "4.0": report.rows.filter(r => r.platform === "4.0").length,
        "5.0": report.rows.filter(r => r.platform === "5.0").length,
      },
      rows: report.rows.map(r => ({
        dealer_name: r.dealer_name,
        dealer_id: r.dealer_id,
        template_name: r.template_name,
        platform: r.platform,
      })),
    });
  }

  // ── Upload a copy to S3 (us-west-1 dealer-addendums bucket) ──────────────
  let s3Key: string | null = null;
  try {
    const s3 = new S3Client({
      region: "us-west-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    });
    s3Key = `chromedata-reports/${report.filename}`;
    await s3.send(new PutObjectCommand({
      Bucket: "dealer-addendums",
      Key: s3Key,
      Body: report.xlsxBuffer,
      ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
  } catch (err) {
    // Non-fatal — the email still goes out even if the archive upload fails.
    console.error("[chromedata-usage-report] S3 archive failed:", err instanceof Error ? err.message : err);
  }

  // ── Email the report to billing@chromedata.com ────────────────────────────
  const lastDayPretty = new Date(report.monthLastDay + "T00:00:00Z")
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const firstDayPretty = new Date(report.monthStart + "T00:00:00Z")
    .toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  // ?supersedes=1 — flags this send as a correction of an earlier email for the
  // same month, so ChromeData knows which figure to bill from.
  const supersedes = req.nextUrl.searchParams.get("supersedes") === "1";
  const supersedesLine = supersedes
    ? `<p><strong>This corrected report supersedes the version sent earlier today for ${report.monthLabel}.</strong></p>`
    : "";

  try {
    await sendMandrillEmail({
      subject: `DealerAddendums — ChromeData Usage Report — ${report.monthLabel}${supersedes ? " (corrected)" : ""}`,
      from_email: "billing@dealeraddendums.com",
      from_name: "DealerAddendums Billing",
      to: [
        { email: "billing@chromedata.com", name: "ChromeData Billing", type: "to" },
        { email: "support@dealeraddendums.com", name: "DealerAddendums Support", type: "cc" },
      ],
      html: `<div style="font-family: Roboto, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; color: #333; line-height: 1.6;">
  ${supersedesLine}
  <p>Please find attached the DealerAddendums vehicle image usage report for <strong>${report.monthLabel}</strong>.</p>
  <p>
    Contract: <strong>#9310</strong><br>
    Locations reported: <strong>${report.rows.length}</strong><br>
    Reporting period: ${firstDayPretty} – ${lastDayPretty}
  </p>
  <p>Thank you,<br>DealerAddendums</p>
</div>`,
      attachments: [{
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        name: report.filename,
        content: report.xlsxBuffer.toString("base64"),
      }],
    });
  } catch (err) {
    return NextResponse.json({
      error: `Email delivery failed: ${err instanceof Error ? err.message : "unknown"}`,
      dealers: report.rows.length,
      file: report.filename,
      s3_key: s3Key,
    }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    month: report.month,
    dealers: report.rows.length,
    file: report.filename,
    s3_key: s3Key,
  });
}
