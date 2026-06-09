"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";

// Mirror of lib/bi.ts BiReport (kept inline so the client has no server import).
type BiReport = {
  period: { from: string; to: string };
  generatedAt: string;
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
  const W = 640, H = 220, padL = 60, padR = 16, padT = 16, padB = 40;
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

// Phase 1 = read-only BI surface. The PDF/Excel download + on-demand email
// (Phase 2) are parked for their own review and intentionally not wired here.
export default function BiClient() {
  const initial = prevCalendarMonth();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [report, setReport] = useState<BiReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  const btnPrimary: React.CSSProperties = {
    height: 36, padding: "0 16px", background: BLUE, color: "#fff", border: "none",
    borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer",
  };
  const btnGhost: React.CSSProperties = {
    height: 36, padding: "0 16px", background: "#fff", color: "#333", border: `1px solid ${BORDER}`,
    borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer",
  };

  return (
    <div>
      <PageHeader title="Business Intelligence" subtitle="Acquisition, conversion, churn & revenue" />

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

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: ".06em", color: "rgba(255,255,255,0.7)", margin: "26px 0 10px" }}>
      {children}
    </h2>
  );
}
