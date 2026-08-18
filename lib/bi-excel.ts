// Excel export for the BI report. One workbook: a Summary sheet plus a sheet
// per detail table (acquisition sources, cancellation reasons, monthly
// gross-billable). Numbers must reconcile exactly to the on-screen report and
// the PDF — all three render from the same BiReport object.

import ExcelJS from "exceljs";
import type { BiReport } from "@/lib/bi";

const NAVY = "FF2A2B3C";
const HEADER_TEXT = "FFFFFFFF";

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT }, name: "Calibri" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle" };
  });
}

export async function buildBiExcel(report: BiReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "DA Platform — Business Intelligence";
  wb.created = new Date();

  const periodLabel = `${report.period.from} → ${report.period.to}`;

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Metric", key: "metric", width: 38 },
    { header: "Value", key: "value", width: 22 },
  ];
  styleHeader(summary.getRow(1));
  const rows: [string, string | number][] = [
    ["Period", periodLabel],
    ["Generated", new Date(report.generatedAt).toLocaleString("en-US")],
    ["", ""],
    ["Paying accounts (current)", report.totals.payingAccounts],
    ["Trial accounts — independent / Funnel A (current)", report.totals.trialAccounts],
    ["Group trials — Funnel B (current)", report.totals.groupTrialAccounts],
    ["", ""],
    ["Funnel A — trials started (independent)", report.trials.started],
    ["Funnel A — cohort conversion rate (%) — converted ÷ started", report.trials.conversionRate],
    ["Funnel A — cohort converted", report.trials.cohort.converted],
    ["Funnel A — cohort lost", report.trials.cohort.lost],
    ["Funnel A — cohort still active", report.trials.cohort.stillActive],
    ["", ""],
    ["Funnel B — group trials started (reseller/group-created)", report.groupTrials.started],
    ["Funnel B — cohort conversion rate (%)", report.groupTrials.conversionRate],
    ["Funnel B — cohort converted", report.groupTrials.cohort.converted],
    ["Funnel B — cohort lost", report.groupTrials.cohort.lost],
    ["Funnel B — cohort still active", report.groupTrials.cohort.stillActive],
    ["", ""],
    ["Period activity — trial conversions (Funnel A, independent)", report.trials.activity.trialConversions],
    ["Period activity — trial conversions (Funnel B, reseller/group)", report.trials.activity.trialConversionsGroup],
    ["Period activity — migrations & group go-lives", report.trials.activity.migrations],
    ["Period activity — trials lost (total)", report.trials.activity.lost],
    ["Period activity — trials lost (independent)", report.trials.activity.lostIndependent],
    ["Period activity — trials lost (group)", report.trials.activity.lostGroup],
    ["", ""],
    ["Group dealer accounts added (provisioned paying — excludes Funnel B trials)", report.groupDealersAdded],
    ["", ""],
    ["Cancellations — independent", report.cancellations.independent],
    ["Cancellations — group", report.cancellations.group],
    ["Cancellations — total", report.cancellations.total],
    ["Cancellations without a reason row", report.cancellations.withoutReason],
    ["Archived (60-day) — independent", report.cancellations.archivedIndependent],
    ["Archived (60-day) — group", report.cancellations.archivedGroup],
    ["", ""],
    ["Current MRR run-rate", report.revenue.available ? report.revenue.currentMrr : "(unavailable)"],
  ];
  rows.forEach((r) => summary.addRow({ metric: r[0], value: r[1] }));

  // ── Acquisition sources ─────────────────────────────────────────────────
  const acq = wb.addWorksheet("Acquisition Sources");
  acq.columns = [
    { header: "Source", key: "source", width: 32 },
    { header: "Trials started", key: "count", width: 18 },
  ];
  styleHeader(acq.getRow(1));
  if (report.acquisition.length === 0) acq.addRow({ source: "(none)", count: 0 });
  report.acquisition.forEach((a) => acq.addRow({ source: a.source, count: a.count }));

  // ── Cancellation reasons ──────────────────────────────────────────────────
  const reasons = wb.addWorksheet("Cancellation Reasons");
  reasons.columns = [
    { header: "Reason", key: "reason", width: 36 },
    { header: "Independent", key: "independent", width: 16 },
    { header: "Group", key: "group", width: 12 },
    { header: "Total", key: "total", width: 12 },
  ];
  styleHeader(reasons.getRow(1));
  if (report.cancellations.reasons.length === 0) {
    reasons.addRow({ reason: "(none)", independent: 0, group: 0, total: 0 });
  }
  report.cancellations.reasons.forEach((r) =>
    reasons.addRow({ reason: r.reason, independent: r.independent, group: r.group, total: r.total }),
  );

  // ── Gross-billable (monthly) ──────────────────────────────────────────────
  const gb = wb.addWorksheet("Gross Billable");
  gb.columns = [
    { header: "Month", key: "month", width: 18 },
    { header: "Gross billed ($)", key: "grossBilled", width: 20 },
  ];
  styleHeader(gb.getRow(1));
  if (!report.revenue.available) {
    gb.addRow({ month: "(unavailable)", grossBilled: report.revenue.error ?? "" });
  } else {
    if (report.revenue.series.length === 0) gb.addRow({ month: "(none)", grossBilled: 0 });
    report.revenue.series.forEach((s) => gb.addRow({ month: s.month, grossBilled: s.grossBilled }));
    gb.addRow({ month: "Current MRR run-rate", grossBilled: report.revenue.currentMrr });
  }
  gb.getColumn("grossBilled").numFmt = '#,##0.00';

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}
