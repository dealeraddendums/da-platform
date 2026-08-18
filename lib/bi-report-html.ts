// HTML report for the BI PDF export. Rendered to PDF by da-pdf-service
// (HTML→PDF). Self-contained — inline styles only, no external assets — and
// uses the DA design system (navy/orange/blue, white cards, Roboto). The
// gross-billable trend is an inline SVG line chart so it survives the headless
// render without a chart library. Numbers reconcile to the on-screen report and
// the Excel export (all three render from the same BiReport).

import type { BiReport } from "@/lib/bi";

const NAVY = "#2a2b3c";
const ORANGE = "#ffa500";
const BLUE = "#1976d2";
const BORDER = "#e0e0e0";
const MUTED = "#78828c";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function card(label: string, value: string, sub?: string): string {
  return `
    <div style="border:1px solid ${BORDER};border-radius:6px;padding:16px 18px;background:#fff;">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">${esc(label)}</div>
      <div style="font-size:28px;font-weight:700;color:${NAVY};margin-top:6px;line-height:1;">${esc(value)}</div>
      ${sub ? `<div style="font-size:12px;color:${MUTED};margin-top:6px;">${esc(sub)}</div>` : ""}
    </div>`;
}

/** Inline SVG line chart of the monthly gross-billable series. */
function trendSvg(series: { month: string; grossBilled: number }[]): string {
  if (series.length === 0) return `<div style="color:${MUTED};font-size:13px;">No data in range.</div>`;
  const W = 370, H = 200, padL = 78, padR = 14, padT = 16, padB = 36;
  const max = Math.max(1, ...series.map((s) => s.grossBilled));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const pts = series.map((s, i) => `${x(i)},${y(s.grossBilled)}`).join(" ");
  const dots = series.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.grossBilled)}" r="3" fill="${BLUE}" />`).join("");
  // Y gridlines at 0, 50%, 100%.
  const grid = [0, 0.5, 1].map((f) => {
    const gy = padT + innerH - f * innerH;
    return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${BORDER}" stroke-width="1" />
      <text x="${padL - 8}" y="${gy + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${money(max * f)}</text>`;
  }).join("");
  // X labels — thin out when crowded.
  const step = Math.ceil(n / 8);
  const labels = series.map((s, i) =>
    i % step === 0 ? `<text x="${x(i)}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(s.month)}</text>` : "",
  ).join("");
  return `<svg width="100%" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    ${grid}
    <polyline points="${pts}" fill="none" stroke="${BLUE}" stroke-width="2" />
    ${dots}
    ${labels}
  </svg>`;
}

function reasonsTable(report: BiReport): string {
  const rows = report.cancellations.reasons;
  const body = rows.length === 0
    ? `<tr><td colspan="4" style="padding:10px 12px;color:${MUTED};font-size:12px;">No cancellations in period.</td></tr>`
    : rows.map((r) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;">${esc(r.reason)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;text-align:right;">${r.independent}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;text-align:right;">${r.group}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;text-align:right;font-weight:600;">${r.total}</td>
        </tr>`).join("");
  return `
    <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER};border-radius:6px;overflow:hidden;">
      <thead><tr style="background:#f7f8fa;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Reason</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Independent</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Group</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Total</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function acqTable(report: BiReport): string {
  const body = report.acquisition.length === 0
    ? `<tr><td colspan="2" style="padding:10px 12px;color:${MUTED};font-size:12px;">No trials started in period.</td></tr>`
    : report.acquisition.map((a) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;">${esc(a.source)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};font-size:12px;text-align:right;font-weight:600;">${a.count}</td>
        </tr>`).join("");
  return `
    <table style="width:100%;border-collapse:collapse;border:1px solid ${BORDER};border-radius:6px;overflow:hidden;">
      <thead><tr style="background:#f7f8fa;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Source</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:${MUTED};">Trials started</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

export function buildBiReportHtml(report: BiReport): string {
  const periodLabel = `${report.period.from} → ${report.period.to}`;
  const generated = new Date(report.generatedAt).toLocaleString("en-US");
  const mrr = report.revenue.available ? money(report.revenue.currentMrr) : "—";

  const definitions = `
    Funnel A = independent (no group) trials — inbound self-serve. Funnel B = reseller/group-created trials
    (explicit Trial on a group dealer, or ss_-born with an outcome); the two never mix. Converted = became paid
    (dated by converted_at); migrations/go-lives also stamp converted_at and are never counted as trial wins.
    Lost trial = trial window closed without converting (30 days, honoring trial_ends_at extensions).
    Cancellation = downgraded_at in period. Acquisition source present only for self-serve signups
    post-migration-087 (else Direct/Unknown). Gross billable = da-billing invoiced totals/month (post-discount);
    MRR run-rate = recurring subscription lines of live-billing, non-paused templates. Default period =
    current calendar month to date.`;

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  @page { size: letter; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: Roboto, Arial, sans-serif; color: ${NAVY}; margin: 0; padding: 32px 36px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: ${MUTED}; margin: 26px 0 10px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
</style></head>
<body>
  <div style="display:flex;align-items:flex-end;justify-content:space-between;border-bottom:3px solid ${ORANGE};padding-bottom:10px;">
    <div>
      <h1>DA Business Intelligence</h1>
      <div style="font-size:13px;color:${MUTED};margin-top:4px;">Period: ${esc(periodLabel)}</div>
    </div>
    <div style="font-size:11px;color:${MUTED};text-align:right;">Generated ${esc(generated)}</div>
  </div>

  <div style="margin-top:12px;font-size:12px;color:${NAVY};">
    <strong>Current book</strong> (as of generation, all-time):
    <span style="margin-left:8px;">Paying accounts <strong>${report.totals.payingAccounts}</strong></span>
    <span style="margin-left:14px;">Trial accounts — independent, Funnel A <strong>${report.totals.trialAccounts}</strong></span>
    <span style="margin-left:14px;">Group trials — Funnel B <strong>${report.totals.groupTrialAccounts}</strong></span>
  </div>

  <h2>Funnel A — inbound self-serve trials (independent · this period&rsquo;s cohort)</h2>
  <div class="grid3">
    ${card("Trials started", String(report.trials.started), "independent (no group), created in period")}
    ${card("Cohort conversion rate", `${report.trials.conversionRate}%`, `${report.trials.cohort.converted} of ${report.trials.cohort.started} converted${report.trials.cohort.stillActive > 0 ? ` · provisional — ${report.trials.cohort.stillActive} still in trial` : ""}`)}
    ${card("Cohort lost", String(report.trials.cohort.lost), "expired or closed without converting")}
  </div>
  <div style="font-size:11px;color:${MUTED};margin-top:8px;">
    Cohort reconciliation: ${report.trials.cohort.started} started =
    ${report.trials.cohort.converted} converted + ${report.trials.cohort.lost} lost +
    ${report.trials.cohort.stillActive} still active. Rate is cohort-based (converted ÷ started).
  </div>

  <h2>Funnel B — reseller / group-created trials (this period&rsquo;s cohort)</h2>
  <div class="grid3">
    ${card("Group trials started", String(report.groupTrials.started), "created by a reseller/group as a Trial")}
    ${card("Cohort conversion rate", `${report.groupTrials.conversionRate}%`, `${report.groupTrials.cohort.converted} of ${report.groupTrials.cohort.started} converted${report.groupTrials.cohort.stillActive > 0 ? ` · provisional — ${report.groupTrials.cohort.stillActive} still in trial` : ""}`)}
    ${card("Cohort lost", String(report.groupTrials.cohort.lost), "expired or closed without converting")}
  </div>
  <div style="font-size:11px;color:${MUTED};margin-top:8px;">
    Cohort reconciliation: ${report.groupTrials.cohort.started} started =
    ${report.groupTrials.cohort.converted} converted + ${report.groupTrials.cohort.lost} lost +
    ${report.groupTrials.cohort.stillActive} still active. Group dealers provisioned directly as paying are not trials
    (they count under Group dealers added). Converted history counts only ss_-born group trials.
  </div>

  <h2>Period activity (any cohort — raw counts, not rates)</h2>
  <div class="grid3">
    ${card("Trials converted in period", String(report.trials.activity.trialConversions), `independent (Funnel A) · +${report.trials.activity.trialConversionsGroup} reseller/group (Funnel B)`)}
    ${card("Migrations & go-lives", String(report.trials.activity.migrations), "4.0 → 5.0 cutovers + group store activations — not trial wins")}
    ${card("Trials lost in period", String(report.trials.activity.lost), `${report.trials.activity.lostIndependent} independent · ${report.trials.activity.lostGroup} group · 30-day window closed`)}
  </div>

  <h2>Accounts added &amp; churn</h2>
  <div class="grid3">
    ${card("Group dealers added", String(report.groupDealersAdded), "provisioned paying — group-created trials count in Funnel B")}
    ${card("Cancellations — Independent", String(report.cancellations.independent))}
    ${card("Cancellations — Group", String(report.cancellations.group))}
  </div>
  <div style="margin-top:16px;">${reasonsTable(report)}</div>
  <div style="font-size:11px;color:${MUTED};margin-top:8px;">
    Reconciliation: ${report.cancellations.withoutReason} of ${report.cancellations.total} cancellations have no closure row this period.
  </div>
  ${(report.cancellations.archivedIndependent || report.cancellations.archivedGroup)
    ? `<div style="font-size:11px;color:${MUTED};margin-top:8px;">Also archived (60-day, later stage): ${report.cancellations.archivedIndependent} independent · ${report.cancellations.archivedGroup} group.</div>`
    : ""}

  <h2>How trials found us</h2>
  <div>${acqTable(report)}</div>

  <h2>Revenue</h2>
  <div class="grid2" style="align-items:start;">
    <div style="border:1px solid ${BORDER};border-radius:6px;padding:16px;background:#fff;">
      ${report.revenue.available ? trendSvg(report.revenue.series) : `<div style="color:${MUTED};font-size:13px;">Gross-billable unavailable: ${esc(report.revenue.error ?? "")}</div>`}
      <div style="font-size:11px;color:${MUTED};margin-top:8px;">Gross billable (invoiced totals/month, post-discount)</div>
    </div>
    ${card("Current MRR run-rate", mrr)}
  </div>

  <h2>Definitions</h2>
  <div style="font-size:10px;color:${MUTED};line-height:1.6;">${esc(definitions)}</div>
</body></html>`;
}
