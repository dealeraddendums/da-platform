"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

// Mirror of lib/bi.ts BiReport (kept inline so the client has no server import).
type BiReport = {
  period: { from: string; to: string };
  generatedAt: string;
  totals: { payingAccounts: number; trialAccounts: number };
  trials: {
    started: number; converted: number; convertedIndependent: number; conversionRate: number;
    lost: number; lostIndependent: number; lostGroup: number;
    cohort: { started: number; converted: number; lost: number; stillActive: number };
  };
  acquisition: { source: string; count: number }[];
  groupDealersAdded: number;
  cancellations: {
    independent: number; group: number; total: number; withoutReason: number;
    archivedIndependent: number; archivedGroup: number;
    reasons: { reason: string; independent: number; group: number; total: number }[];
  };
  revenue: { available: boolean; series: { month: string; grossBilled: number }[]; currentMrr: number; error?: string };
};

// Mirror of lib/bi.ts PeriodSummary.
type PeriodSummaryRow = {
  label: string; newTrials: number; trialsWon: number; trialsLost: number;
  groupAdded: number; manualAdded: number; downgradedFree: number;
  newPaying: number; growthPct: number | null;
};
type PeriodSummary = { periods: PeriodSummaryRow[]; totalPaying: number; generatedAt: string };

const NAVY = "#2a2b3c";
const BLUE = "#1976d2";
const BORDER = "#e0e0e0";
const MUTED = "#78828c";

function prevCalendarMonth(): { from: string; to: string } {
  const now = new Date();
  const firstOfThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfPrev = new Date(firstOfThis.getTime() - 86400000);
  const firstOfPrev = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: fmt(firstOfPrev), to: fmt(lastOfPrev) };
}

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const cardStyle: React.CSSProperties = {
  background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 6, padding: "16px 18px",
};
const th: React.CSSProperties = {
  textAlign: "left", padding: "8px 12px", fontSize: 10, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: ".05em", color: MUTED, background: "#f7f8fa",
  borderBottom: `1px solid ${BORDER}`,
};
const td: React.CSSProperties = { padding: "8px 12px", fontSize: 13, color: NAVY, borderBottom: `1px solid ${BORDER}` };
const tdR: React.CSSProperties = { ...td, textAlign: "right" };

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em", color: MUTED }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: NAVY, marginTop: 6, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function TrendChart({ series }: { series: { month: string; grossBilled: number }[] }) {
  if (series.length === 0) return <div style={{ color: MUTED, fontSize: 13 }}>No data in range.</div>;
  const W = 640, H = 220, padL = 78, padR = 16, padT = 16, padB = 40;
  const max = Math.max(1, ...series.map((s) => s.grossBilled));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = series.length;
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const pts = series.map((s, i) => `${x(i)},${y(s.grossBilled)}`).join(" ");
  const step = Math.ceil(n / 8);
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[0, 0.5, 1].map((f) => {
        const gy = padT + innerH - f * innerH;
        return (
          <g key={f}>
            <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke={BORDER} strokeWidth={1} />
            <text x={padL - 8} y={gy + 4} textAnchor="end" fontSize={10} fill={MUTED}>{money(max * f)}</text>
          </g>
        );
      })}
      <polyline points={pts} fill="none" stroke={BLUE} strokeWidth={2} />
      {series.map((s, i) => <circle key={i} cx={x(i)} cy={y(s.grossBilled)} r={3} fill={BLUE} />)}
      {series.map((s, i) => i % step === 0
        ? <text key={`l${i}`} x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize={10} fill={MUTED}>{s.month}</text>
        : null)}
    </svg>
  );
}

// Phase 2: read surface + PDF/Excel download + on-demand email. Export/email
// hit /api/admin/bi/export and /api/admin/bi/email, which build from the same
// buildBiReport() as the read endpoint — so PDF == Excel == on-screen, and the
// is_test / excludeCustomerIds exclusions are inherited automatically.
export default function BiClient({ defaultRecipient }: { defaultRecipient: string }) {
  const initial = prevCalendarMonth();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<BiReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "pdf" | "xlsx" | "email">("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [recipients, setRecipients] = useState(defaultRecipient);
  const [toast, setToast] = useState<string | null>(null);
  const [periodSummary, setPeriodSummary] = useState<PeriodSummary | null>(null);
  const [periodErr, setPeriodErr] = useState<string | null>(null);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/bi?from=${f}&to=${t}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Failed to load");
      setReport(j as BiReport);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(initial.from, initial.to); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Period summary: fixed windows, independent of the date picker — fetch once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/bi/period-summary")
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "Failed to load"); return j as PeriodSummary; })
      .then((j) => { if (!cancelled) setPeriodSummary(j); })
      .catch((e) => { if (!cancelled) setPeriodErr(e instanceof Error ? e.message : "Failed to load"); });
    return () => { cancelled = true; };
  }, []);

  // Download the export for the CURRENT from/to so the file matches what's
  // on screen (same period → same buildBiReport → same numbers).
  async function download(format: "pdf" | "xlsx") {
    setBusy(format); setErr(null);
    try {
      const res = await fetch(`/api/admin/bi/export?format=${format}&from=${from}&to=${to}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `da-bi-${from}_${to}.${format}`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy("");
    }
  }

  async function sendEmail() {
    setBusy("email"); setErr(null);
    try {
      const res = await fetch(`/api/admin/bi/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, recipients: recipients.split(",").map((r) => r.trim()).filter(Boolean) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Email failed (${res.status})`);
      setEmailOpen(false);
      setToast(`Report emailed to ${(j.recipients ?? []).join(", ")}`);
      setTimeout(() => setToast(null), 6000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Email failed");
    } finally {
      setBusy("");
    }
  }

  const btnPrimary: React.CSSProperties = {
    height: 36, padding: "0 16px", background: BLUE, color: "#fff", border: "none",
    borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer",
  };
  const btnGhost: React.CSSProperties = {
    height: 36, padding: "0 16px", background: "#fff", color: "#333", border: `1px solid ${BORDER}`,
    borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer",
  };

  const actions = (
    <div style={{ display: "flex", gap: 8 }}>
      <button style={{ ...btnGhost, opacity: !report || busy === "pdf" ? 0.6 : 1 }} disabled={!report || busy === "pdf"} onClick={() => void download("pdf")}>
        {busy === "pdf" ? "Generating…" : "Download PDF"}
      </button>
      <button style={{ ...btnGhost, opacity: !report || busy === "xlsx" ? 0.6 : 1 }} disabled={!report || busy === "xlsx"} onClick={() => void download("xlsx")}>
        {busy === "xlsx" ? "Generating…" : "Download Excel"}
      </button>
      <button style={{ ...btnPrimary, opacity: !report ? 0.6 : 1 }} disabled={!report} onClick={() => setEmailOpen((v) => !v)}>
        Email report
      </button>
    </div>
  );

  return (
    <div>
      <PageHeader title="Business Intelligence" subtitle="Acquisition, conversion, churn & revenue" action={actions} />

      {emailOpen && (
        <div style={{ ...cardStyle, marginBottom: 16, display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, color: MUTED, flex: 1, minWidth: 280 }}>
            <div style={{ marginBottom: 4 }}>Recipients (comma-separated)</div>
            <input type="text" value={recipients} onChange={(e) => setRecipients(e.target.value)}
              style={{ width: "100%", height: 34, padding: "0 10px", border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 13 }} />
          </label>
          <button style={{ ...btnPrimary, opacity: busy === "email" ? 0.6 : 1 }} disabled={busy === "email"} onClick={() => void sendEmail()}>
            {busy === "email" ? "Sending…" : "Send PDF + Excel"}
          </button>
          <div style={{ fontSize: 11, color: MUTED, flexBasis: "100%" }}>Sends the current period ({from} → {to}) as PDF + Excel attachments. On-demand only.</div>
        </div>
      )}

      {toast && (
        <div style={{ marginBottom: 16, padding: "10px 14px", background: "#e8f5e9", border: "1px solid #c8e6c9", borderRadius: 6, color: "#2e7d32", fontSize: 13 }}>{toast}</div>
      )}

      {/* Date range */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "flex-end", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: MUTED }}>
          <div style={{ marginBottom: 4 }}>From</div>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            style={{ height: 34, padding: "0 10px", border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 12, color: MUTED }}>
          <div style={{ marginBottom: 4 }}>To</div>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            style={{ height: 34, padding: "0 10px", border: `1px solid ${BORDER}`, borderRadius: 4, fontSize: 13 }} />
        </label>
        <button style={btnPrimary} onClick={() => void load(from, to)} disabled={loading}>
          {loading ? "Loading…" : "Apply"}
        </button>
        <button style={btnGhost} onClick={() => { const p = prevCalendarMonth(); setFrom(p.from); setTo(p.to); void load(p.from, p.to); }}>
          Previous month
        </button>
      </div>

      {err && (
        <div style={{ marginBottom: 16, padding: "10px 14px", background: "#fdecea", border: "1px solid #f5c6cb", borderRadius: 6, color: "#c62828", fontSize: 13 }}>{err}</div>
      )}

      {!report ? (
        <div style={{ color: MUTED, fontSize: 14 }}>{loading ? "Loading report…" : "No data."}</div>
      ) : (
        <>
          <div style={{ ...cardStyle, marginBottom: 16, display: "flex", gap: 28, fontSize: 13, color: NAVY }}>
            <div><span style={{ color: MUTED }}>Current book (all-time): </span><strong>Paying accounts {report.totals.payingAccounts}</strong></div>
            <div><strong>Trial accounts (independent) {report.totals.trialAccounts}</strong></div>
          </div>

          {/* Section A */}
          <SectionTitle>Acquisition &amp; trial funnel (independent)</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Card label="Trials started" value={String(report.trials.started)} sub="independent, created in period" />
            <Card label="Converted to paying" value={String(report.trials.convertedIndependent)} sub={`${report.trials.conversionRate}% conversion rate · ${report.trials.converted} total incl. group`} />
            <Card label="Lost trials" value={String(report.trials.lost)} sub={`${report.trials.lostIndependent} independent · ${report.trials.lostGroup} group · day-cap`} />
          </div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            Cohort reconciliation (trials started this period): {report.trials.cohort.started} started ={" "}
            {report.trials.cohort.converted} converted + {report.trials.cohort.lost} lost +{" "}
            {report.trials.cohort.stillActive} still active.
          </div>

          {/* Acquisition table */}
          <SectionTitle>How trials found us</SectionTitle>
          <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden", maxWidth: 520 }}>
            <thead><tr><th style={th}>Source</th><th style={{ ...th, textAlign: "right" }}>Trials started</th></tr></thead>
            <tbody>
              {report.acquisition.length === 0 ? (
                <tr><td style={td} colSpan={2}>No trials started in period.</td></tr>
              ) : report.acquisition.map((a) => (
                <tr key={a.source}><td style={td}>{a.source}</td><td style={{ ...tdR, fontWeight: 600 }}>{a.count}</td></tr>
              ))}
            </tbody>
          </table>

          {/* Section B */}
          <SectionTitle>Accounts added &amp; churn</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Card label="Group dealers added" value={String(report.groupDealersAdded)} />
            <Card label="Cancellations — Independent" value={String(report.cancellations.independent)} />
            <Card label="Cancellations — Group" value={String(report.cancellations.group)} />
          </div>
          {(report.cancellations.archivedIndependent > 0 || report.cancellations.archivedGroup > 0) && (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
              Also archived (60-day, later stage): {report.cancellations.archivedIndependent} independent · {report.cancellations.archivedGroup} group.
            </div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${BORDER}`, borderRadius: 6, overflow: "hidden", marginTop: 16 }}>
            <thead><tr>
              <th style={th}>Cancellation reason</th>
              <th style={{ ...th, textAlign: "right" }}>Independent</th>
              <th style={{ ...th, textAlign: "right" }}>Group</th>
              <th style={{ ...th, textAlign: "right" }}>Total</th>
            </tr></thead>
            <tbody>
              {report.cancellations.reasons.length === 0 ? (
                <tr><td style={td} colSpan={4}>No cancellations in period.</td></tr>
              ) : report.cancellations.reasons.map((r) => (
                <tr key={r.reason}>
                  <td style={td}>{r.reason}</td>
                  <td style={tdR}>{r.independent}</td>
                  <td style={tdR}>{r.group}</td>
                  <td style={{ ...tdR, fontWeight: 600 }}>{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
            Reconciliation: <strong>{report.cancellations.withoutReason}</strong> of {report.cancellations.total} cancellation{report.cancellations.total === 1 ? "" : "s"} have no closure row this period
            {report.cancellations.withoutReason > 0 ? " (counted under “Not specified” / missing)." : "."}
          </div>

          {/* Section C */}
          <SectionTitle>Revenue</SectionTitle>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, alignItems: "start" }}>
            <div style={cardStyle}>
              {report.revenue.available
                ? <TrendChart series={report.revenue.series} />
                : <div style={{ color: MUTED, fontSize: 13 }}>Gross-billable unavailable: {report.revenue.error}</div>}
              <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>Gross billable (invoiced totals/month, post-discount)</div>
            </div>
            <Card label="Current MRR run-rate" value={report.revenue.available ? money(report.revenue.currentMrr) : "—"} />
          </div>

          {/* Period Summary — fixed windows, independent of the date picker */}
          <SectionTitle>Period Summary</SectionTitle>
          <PeriodSummaryGrid summary={periodSummary} error={periodErr} />

          {/* Definitions */}
          <SectionTitle>Definitions</SectionTitle>
          <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.7, maxWidth: 900 }}>
            <strong>Trial</strong> = account_type Trial/NULL; <strong>Independent</strong> = no group.{" "}
            <strong>Converted</strong> = became paid (dated by converted_at).{" "}
            <strong>Lost trial</strong> = past the 30-day/30-print allowance without converting (day-cap shown; print-cap approximate).{" "}
            <strong>Cancellation</strong> = previously-paid dealer with downgraded_at in period.{" "}
            Acquisition source present only for self-serve signups post-migration-087 (else Direct/Unknown).{" "}
            Reasons present only where an account_closures row exists (admin downgrades default to &ldquo;Admin downgrade&rdquo;).{" "}
            <strong>Gross billable</strong> = invoiced totals/month (post-discount) from da-billing.{" "}
            Period = previous calendar month by default. Generated {new Date(report.generatedAt).toLocaleString("en-US")}.
          </div>
        </>
      )}
    </div>
  );
}

function PeriodSummaryGrid({ summary, error }: { summary: PeriodSummary | null; error: string | null }) {
  if (error) return <div style={{ ...cardStyle, color: "#c62828", fontSize: 13 }}>{error}</div>;
  if (!summary) return <div style={{ ...cardStyle, color: MUTED, fontSize: 13 }}>Loading…</div>;

  const rows: { label: string; key: keyof PeriodSummaryRow; strong?: boolean }[] = [
    { label: "New Trials",          key: "newTrials" },
    { label: "Trials Won",          key: "trialsWon" },
    { label: "Trials Lost",         key: "trialsLost" },
    { label: "Group Dealers Added", key: "groupAdded" },
    { label: "Manually Added",      key: "manualAdded" },
    { label: "Downgraded to Free",  key: "downgradedFree" },
    { label: "New Paying",          key: "newPaying", strong: true },
    { label: "Growth %",            key: "growthPct", strong: true },
  ];

  const stickyBase: React.CSSProperties = {
    position: "sticky", left: 0, textAlign: "right", whiteSpace: "nowrap",
    minWidth: 150, borderRight: `1px solid ${BORDER}`,
  };
  const num: React.CSSProperties = {
    ...td, textAlign: "center", fontVariantNumeric: "tabular-nums", minWidth: 62,
  };

  return (
    <div style={{ ...cardStyle, padding: 0, overflowX: "auto" }}>
      <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...th, ...stickyBase, background: "#f7f8fa", zIndex: 2 }} />
            {summary.periods.map((p) => (
              <th key={p.label} style={{ ...th, textAlign: "center" }}>{p.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td style={{
                ...td, ...stickyBase, fontWeight: r.strong ? 700 : 600, color: NAVY,
                background: r.strong ? "#f0f2f5" : "#fff", zIndex: 1,
                borderTop: r.key === "newPaying" ? `2px solid ${BORDER}` : undefined,
              }}>
                {r.label}
              </td>
              {summary.periods.map((p) => {
                if (r.key === "growthPct") {
                  const v = p.growthPct;
                  const noBase = v == null;
                  const color = noBase || v === 0 ? MUTED : v > 0 ? "#2e7d32" : "#c62828";
                  return (
                    <td key={p.label} style={{ ...num, fontWeight: 700, color, background: "#f9fafb" }}>
                      {noBase || v === 0 ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`}
                    </td>
                  );
                }
                const v = p[r.key] as number;
                return (
                  <td key={p.label} style={{
                    ...num,
                    fontWeight: r.strong ? 700 : 400,
                    background: r.strong ? "#f9fafb" : "#fff",
                    borderTop: r.key === "newPaying" ? `2px solid ${BORDER}` : undefined,
                    color: v === 0 ? "#b7bec6" : NAVY,
                  }}>
                    {v}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "8px 12px", fontSize: 11, color: MUTED, borderTop: `1px solid ${BORDER}` }}>
        Growth % = (New Paying − Downgraded) ÷ current paying base ({summary.totalPaying.toLocaleString("en-US")}).
        Weeks start Monday; quarters are calendar {new Date(summary.generatedAt).getFullYear()}. Fixed windows — the date picker above does not affect this grid.
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "rgba(255,255,255,0.7)", margin: "26px 0 10px" }}>
      {children}
    </h2>
  );
}
