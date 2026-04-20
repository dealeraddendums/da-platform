"use client";

import { useState, useEffect, useCallback } from "react";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

type OptionUsageRow = { option_name: string; count: number };
type DealerActivityRow = {
  dealer_id: string;
  dealer_name: string;
  total_addendums: number;
  last_activity: string | null;
  top_option: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const th: React.CSSProperties = {
  textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)",
  background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)",
};
const td: React.CSSProperties = {
  padding: "10px 16px", fontSize: 13, color: "var(--text-primary)",
  borderBottom: "1px solid var(--border)",
};

// ── Date range bar ────────────────────────────────────────────────────────────

function DateRangeBar({
  from, to, onChange,
}: {
  from: string; to: string;
  onChange: (from: string, to: string) => void;
}) {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);

  const presets = [
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
    { label: "1 year", days: 365 },
    { label: "All time", days: 0 },
  ];

  function applyPreset(days: number) {
    const end = new Date();
    const start = days > 0 ? new Date(Date.now() - days * 86400000) : new Date("2010-01-01");
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    setF(fmt(start)); setT(fmt(end));
    onChange(fmt(start), fmt(end));
  }

  const inp: React.CSSProperties = {
    height: 32, padding: "0 8px", fontSize: 12, borderRadius: 4,
    border: "1px solid var(--border)", background: "white", color: "var(--text-primary)",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {presets.map(p => (
        <button key={p.label} type="button" onClick={() => applyPreset(p.days)}
          style={{ height: 28, padding: "0 10px", fontSize: 11, fontWeight: 600, borderRadius: 4,
            border: "1px solid var(--border)", background: "white", color: "var(--text-secondary)", cursor: "pointer" }}>
          {p.label}
        </button>
      ))}
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>or</span>
      <input type="date" value={f} onChange={e => setF(e.target.value)} style={inp} />
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>→</span>
      <input type="date" value={t} onChange={e => setT(e.target.value)} style={inp} />
      <button type="button"
        onClick={() => onChange(f, t)}
        style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 600, borderRadius: 4,
          background: "#1976d2", color: "#fff", border: "none", cursor: "pointer" }}>
        Apply
      </button>
    </div>
  );
}

// ── Options Usage report ──────────────────────────────────────────────────────

function OptionsUsageReport() {
  const [from, setFrom] = useState("2010-01-01");
  const [to, setTo] = useState(new Date().toISOString().split("T")[0]);
  const [rows, setRows] = useState<OptionUsageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reports/options-usage?from=${f}&to=${t}`);
      const json = await r.json() as { data: OptionUsageRow[]; total: number };
      setRows(json.data ?? []);
      setTotal(json.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(from, to); }, []);

  function handleExport() {
    window.open(`/api/reports/options-usage?from=${from}&to=${to}&format=csv`, "_blank");
  }

  return (
    <div className="card" style={{ marginBottom: 32 }}>
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Options Usage</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
            Most applied options across all dealers · {total.toLocaleString()} total applications
          </p>
        </div>
        <button type="button" onClick={handleExport}
          style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 600, borderRadius: 4,
            border: "1px solid var(--border)", background: "white", color: "var(--text-secondary)", cursor: "pointer" }}>
          Export CSV
        </button>
      </div>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
        <DateRangeBar from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); void load(f, t); }} />
      </div>
      {loading ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No data for this date range.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 48 }}>#</th>
                <th style={th}>Option Name</th>
                <th style={{ ...th, textAlign: "right" }}>Applications</th>
                <th style={{ ...th, textAlign: "right" }}>% of Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.option_name} style={{ background: i % 2 === 0 ? "white" : "var(--bg-subtle)" }}>
                  <td style={{ ...td, color: "var(--text-muted)" }}>{i + 1}</td>
                  <td style={td}>{r.option_name}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{r.count.toLocaleString()}</td>
                  <td style={{ ...td, textAlign: "right", color: "var(--text-muted)" }}>
                    {total > 0 ? ((r.count / total) * 100).toFixed(1) + "%" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Dealer Activity report ────────────────────────────────────────────────────

function DealerActivityReport() {
  const [from, setFrom] = useState("2010-01-01");
  const [to, setTo] = useState(new Date().toISOString().split("T")[0]);
  const [rows, setRows] = useState<DealerActivityRow[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reports/dealer-activity?from=${f}&to=${t}`);
      const json = await r.json() as { data: DealerActivityRow[] };
      setRows(json.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(from, to); }, []);

  function handleExport() {
    window.open(`/api/reports/dealer-activity?from=${from}&to=${to}&format=csv`, "_blank");
  }

  return (
    <div className="card">
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Dealer Activity</h2>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
            Addendum usage per dealer · {rows.length.toLocaleString()} dealers
          </p>
        </div>
        <button type="button" onClick={handleExport}
          style={{ height: 32, padding: "0 14px", fontSize: 12, fontWeight: 600, borderRadius: 4,
            border: "1px solid var(--border)", background: "white", color: "var(--text-secondary)", cursor: "pointer" }}>
          Export CSV
        </button>
      </div>
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
        <DateRangeBar from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); void load(f, t); }} />
      </div>
      {loading ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No data for this date range.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Dealer</th>
                <th style={{ ...th, textAlign: "right" }}>Total Addendums</th>
                <th style={th}>Last Activity</th>
                <th style={th}>Top Option</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.dealer_id} style={{ background: i % 2 === 0 ? "white" : "var(--bg-subtle)" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{r.dealer_name}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.dealer_id}</div>
                  </td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{r.total_addendums.toLocaleString()}</td>
                  <td style={{ ...td, color: "var(--text-muted)" }}>{fmtDate(r.last_activity)}</td>
                  <td style={{ ...td, color: "var(--text-muted)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.top_option ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Reports</h1>
        <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.6)" }}>
          Historical addendum data across all dealers
        </p>
      </div>
      <OptionsUsageReport />
      <DealerActivityReport />
    </div>
  );
}
