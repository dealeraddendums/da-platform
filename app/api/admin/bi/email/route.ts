// POST /api/admin/bi/email  { from?, to?, recipients? }
// Generates the BI report PDF + Excel and emails them via Mandrill, both
// attached. super_admin only. On-demand only (no cron). Default recipient is
// the acting super_admin's email (the UI prefills allan@dealeraddendums.com).

import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { buildBiReport } from "@/lib/bi";
import { resolvePeriod } from "@/lib/bi-period";
import { generateBiPdf, generateBiExcel, biFileStem, PDF_MIME, XLSX_MIME } from "@/lib/bi-export";
import { sendMandrillEmail } from "@/lib/mandrill";

export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
  if (error) return error;

  let body: { from?: string; to?: string; recipients?: string[] | string };
  try { body = (await req.json()) as typeof body; }
  catch { body = {}; }

  const { from, to, errorResponse } = resolvePeriod(body.from ?? null, body.to ?? null);
  if (errorResponse) return errorResponse;

  // Resolve recipients: explicit list (array or comma-separated) → validated;
  // else default to the acting super_admin's email.
  let recipients: string[];
  if (Array.isArray(body.recipients)) {
    recipients = body.recipients;
  } else if (typeof body.recipients === "string") {
    recipients = body.recipients.split(",");
  } else {
    recipients = [claims.email];
  }
  recipients = recipients.map((r) => r.trim()).filter(Boolean);
  const invalid = recipients.filter((r) => !EMAIL_RE.test(r));
  if (recipients.length === 0) {
    return NextResponse.json({ error: "At least one recipient is required" }, { status: 400 });
  }
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Invalid email(s): ${invalid.join(", ")}` }, { status: 400 });
  }

  try {
    const report = await buildBiReport(from, to);
    const stem = biFileStem(report);
    const [pdf, xlsx] = await Promise.all([generateBiPdf(report), generateBiExcel(report)]);

    const periodLabel = `${report.period.from} → ${report.period.to}`;
    const html = `
      <div style="font-family:Roboto,Arial,sans-serif;color:#2a2b3c;">
        <h2 style="margin:0 0 8px;">DA Business Intelligence</h2>
        <p style="margin:0 0 12px;color:#55595c;">Report for <strong>${periodLabel}</strong> is attached as PDF and Excel.</p>
        <ul style="color:#55595c;font-size:14px;line-height:1.6;">
          <li>Paying accounts (current): <strong>${report.totals.payingAccounts}</strong></li>
          <li>Trial accounts, independent (current): <strong>${report.totals.trialAccounts}</strong></li>
          <li>Trials started: <strong>${report.trials.started}</strong> — cohort: ${report.trials.cohort.converted} converted (${report.trials.conversionRate}%), ${report.trials.cohort.lost} lost, ${report.trials.cohort.stillActive} still in trial</li>
          <li>Period activity: <strong>${report.trials.activity.trialConversions}</strong> trial conversions · ${report.trials.activity.migrations} migrations went live · ${report.trials.activity.lost} trials lost</li>
          <li>Group dealers added: <strong>${report.groupDealersAdded}</strong></li>
          <li>Cancellations: <strong>${report.cancellations.total}</strong> (${report.cancellations.independent} independent · ${report.cancellations.group} group)</li>
          <li>Current MRR run-rate: <strong>${report.revenue.available ? `$${report.revenue.currentMrr.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "—"}</strong></li>
        </ul>
        <p style="margin:12px 0 0;color:#9aa0a6;font-size:12px;">Generated ${new Date(report.generatedAt).toLocaleString("en-US")}.</p>
      </div>`;

    await sendMandrillEmail({
      subject: `DA Business Intelligence — ${periodLabel}`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Business Intelligence",
      to: recipients.map((email) => ({ email, type: "to" as const })),
      html,
      attachments: [
        { type: PDF_MIME, name: `${stem}.pdf`, content: pdf.toString("base64") },
        { type: XLSX_MIME, name: `${stem}.xlsx`, content: xlsx.toString("base64") },
      ],
    });

    return NextResponse.json({ ok: true, recipients });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Email failed" },
      { status: 500 },
    );
  }
}
