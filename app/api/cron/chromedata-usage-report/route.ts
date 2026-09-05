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
 * archiving anything. Any failure — and any zero-dealer result — emails an
 * alert to support@/allan@ rather than failing silently; ?allow_empty=1
 * overrides the zero-dealer block.
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
    // A dry run is a human action with the error on screen — no alert needed.
    if (req.nextUrl.searchParams.get("dry_run") !== "1") {
      const month = req.nextUrl.searchParams.get("month") ?? "(previous month)";
      await alertReportFailure(`build failed for ${month}`, `
  <p>The report could not be built, so no email or S3 archive was produced.</p>
  <p><strong>Error:</strong> <code>${escapeHtml(msg)}</code></p>
  <p>The most likely cause is the <strong>ETL box being unreachable</strong>
  (<code>etl.migration.dealeraddendums.com</code>). It supplies the 4.0 / Aurora half of the report —
  da-platform has no Aurora access of its own — and the builder deliberately fails rather than
  emailing a 5.0-only partial. Check that the box is up and <code>da-legacy-etl</code> is running
  under PM2, then re-run.</p>`);
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Minimal escaping for error text interpolated into the alert email. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Alert the team that the report did NOT reach ChromeData.
 *
 * Every failure path here is otherwise silent: the monthly EasyCron job is the
 * only caller, nobody watches its HTTP status, and the deadline is the 10th. A
 * failed send looks exactly like a successful one from the outside — which is
 * how "Locations reported: 0" went out unnoticed in the first place.
 *
 * Never throws: an alert that fails must not turn one problem into two, and the
 * caller still returns a non-2xx so EasyCron records the failure.
 */
async function alertReportFailure(subject: string, bodyHtml: string): Promise<void> {
  try {
    await sendMandrillEmail({
      subject: `⚠️ ChromeData usage report — ${subject}`,
      from_email: "billing@dealeraddendums.com",
      from_name: "DealerAddendums Billing",
      to: [
        { email: "support@dealeraddendums.com", name: "DealerAddendums Support", type: "to" },
        { email: "allan@dealeraddendums.com", name: "Allan Tone", type: "cc" },
      ],
      html: `<div style="font-family: Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; color: #333; line-height: 1.6;">
  <p><strong>Nothing was sent to ChromeData.</strong></p>
  ${bodyHtml}
  <p style="color:#666; font-size: 13px;">Contract #9310 reports are due by the 10th. Re-run from
  Reports → ChromeData Usage Report, or
  <code>POST /api/cron/chromedata-usage-report?month=YYYY-MM</code> with the cron secret. Add
  <code>&amp;dry_run=1</code> first to inspect the dealer list without sending.</p>
</div>`,
    });
  } catch (err) {
    console.error("[chromedata-usage-report] failure alert could not be sent:", err);
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
      // The exact workbook that would have been attached, so the sheet itself
      // can be opened and checked before a send.
      xlsx_base64: report.xlsxBuffer.toString("base64"),
    });
  }

  // ── Refuse to send an empty report unattended ────────────────────────────
  // This is the original incident, generalised: the builder returned zero rows
  // and the cron cheerfully emailed ChromeData "Locations reported: 0". At ~44
  // qualifying dealers, a drop to zero is a system failure (a broken join, an
  // empty ETL response), not a business reality — so it stops here and pages a
  // human instead. ?allow_empty=1 forces the send if a month genuinely has none.
  if (report.rows.length === 0 && req.nextUrl.searchParams.get("allow_empty") !== "1") {
    await alertReportFailure(`zero dealers for ${report.monthLabel} — send blocked`, `
  <p>The report built successfully but contained <strong>zero dealers</strong>, so the send was
  blocked rather than reporting "Locations reported: 0" to ChromeData.</p>
  <p>Check both halves: the 4.0 branch (ETL box <code>/chromedata-usage</code>, which supplies
  almost every qualifying dealer) and the 5.0 branch. Run with <code>&amp;dry_run=1</code> to see
  what the builder found.</p>
  <p>If the month legitimately has no qualifying dealers, re-run with
  <code>&amp;allow_empty=1</code> to send it anyway.</p>`);
    return NextResponse.json({
      error: "Report contained zero dealers — send blocked. Re-run with allow_empty=1 to override.",
      month: report.month,
      dealers: 0,
    }, { status: 409 });
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
    const msg = err instanceof Error ? err.message : "unknown";
    await alertReportFailure(`email delivery failed for ${report.monthLabel}`, `
  <p>The report built correctly (<strong>${report.rows.length}</strong> dealers) but Mandrill
  rejected the send, so ChromeData never received it.</p>
  <p><strong>Error:</strong> <code>${escapeHtml(msg)}</code></p>
  ${s3Key ? `<p>The workbook was archived to S3 at <code>${escapeHtml(s3Key)}</code> and can be sent by hand if needed.</p>` : ""}`);
    return NextResponse.json({
      error: `Email delivery failed: ${msg}`,
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
