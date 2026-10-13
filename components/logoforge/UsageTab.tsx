"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ERROR_BOX, fmtDate, MUTED, StatusBadge } from "./shared";

type Day = { date: string; vectorize: number; library: number; brand: number; errors: number };
type Week = Omit<Day, "date"> & { week: string };
type Stats = {
  days: number; since: string; generated_at: string;
  totals: {
    vectorize_calls: number; vectorize_ok: number; vectorize_errors: number; library_calls: number;
    library_calls_with_franchises: number; calls_with_replacement: number;
    brand_calls: number; brand_ok: number; brand_rejected: number; brand_errors: number;
    avg_vectorize_ms: number | null; avg_brand_ms: number | null;
  };
  badges: { regions: number; replaced: number; abstained: number; no_match: number; identified: number;
    abstain_rate: number | null; avg_confidence: number | null; confidence_floor: number };
  daily: Day[]; weekly: Week[];
  per_make: { make: string; replaced: number; abstained: number; requested_by_calls: number; avg_score: number | null; library_status: string }[];
  draw_next: { make: string; calls_wanting: number; legacy_matches: number; status: string }[];
  templates: { template: string; calls: number }[];
};

const LIB_STATUS: Record<string, string> = {
  ready: "replacement_ready", awaiting: "awaiting_asset", legacy_only: "legacy_reference",
};

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");

export default function UsageTab() {
  const [days, setDays] = useState(90);
  const [grain, setGrain] = useState<"daily" | "weekly">("daily");
  const [s, setS] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api<Stats>(`usage?days=${days}`).then(setS).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load usage."));
  }, [days]);

  if (error) return <div style={ERROR_BOX}>{error}</div>;
  if (!s) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading usage…</p>;
  const t = s.totals;
  const b = s.badges;
  const cards: { label: string; value: string; sub?: string }[] = [
    { label: "Vectorize calls", value: t.vectorize_calls.toLocaleString(), sub: `${t.vectorize_errors} failed · avg ${t.avg_vectorize_ms ? `${(t.avg_vectorize_ms / 1000).toFixed(1)} s` : "—"}` },
    { label: "Library on", value: t.library_calls.toLocaleString(), sub: `${pct(t.library_calls, t.vectorize_ok)} of successful calls` },
    { label: "Badges replaced", value: b.replaced.toLocaleString(), sub: `${b.abstained} kept (abstained) · ${t.calls_with_replacement} calls with a swap` },
    { label: "Avg match confidence", value: b.avg_confidence != null ? b.avg_confidence.toFixed(3) : "—", sub: `regions scoring ≥ ${b.confidence_floor}` },
    { label: "Abstain rate", value: b.abstain_rate != null ? `${Math.round(b.abstain_rate * 100)}%` : "—", sub: `of ${b.identified} identified badges` },
    { label: "Brand logos", value: t.brand_calls.toLocaleString(), sub: `${t.brand_ok} made · ${t.brand_rejected} rejected input` },
  ];
  const series = grain === "daily" ? s.daily.map((d) => ({ key: d.date, ...d })) : s.weekly.map((w) => ({ key: w.week, ...w }));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
        <p style={{ ...MUTED, margin: 0 }}>Since {s.since} · from LogoForge&apos;s usage log · updated {fmtDate(s.generated_at)}. Includes staff and test calls.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <select className="input" value={grain} onChange={(e) => setGrain(e.target.value as "daily" | "weekly")} style={{ width: 120 }}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option>
          </select>
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 140 }}>
            <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option><option value={365}>Last 365 days</option>
          </select>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12, marginBottom: 20 }}>
        {cards.map((c) => (
          <div key={c.label} style={{ background: "var(--bg-subtle)", border: "1px solid var(--border)", borderRadius: 6, padding: "12px 16px" }}>
            <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", margin: "0 0 4px" }}>{c.label}</p>
            <p style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: 0 }}>{c.value}</p>
            {c.sub && <p style={{ ...MUTED, margin: "2px 0 0" }}>{c.sub}</p>}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>Calls per {grain === "daily" ? "day" : "week"}</p>
          <Legend color="#1976d2" label="Vectorize (library off)" />
          <Legend color="#64b5f6" label="Vectorize (library on)" />
          <Legend color="#ffa500" label="Brand logos" />
        </div>
        <BarChart series={series} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <div className="card" style={{ padding: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px" }}>Makes · badge swaps</p>
          {s.per_make.length === 0 ? <p style={MUTED}>No library-on calls in this period.</p> : (
            <Table head={["Make", "Replaced", "Kept", "In franchise lists", "Avg score", "Library"]}
              rows={s.per_make.map((m) => [
                m.make, m.replaced, m.abstained, m.requested_by_calls, m.avg_score?.toFixed(3) ?? "—",
                LIB_STATUS[m.library_status] ? <StatusBadge key="s" status={LIB_STATUS[m.library_status]} /> : <span key="s" style={MUTED}>not in library</span>,
              ])} />
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card" style={{ padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>Draw these next</p>
            <p style={{ ...MUTED, margin: "0 0 8px" }}>
              Makes a vectorize call listed as a dealer franchise but the library had no replacement-ready asset for, plus badges recognised only from a legacy reference.
            </p>
            {s.draw_next.length === 0 ? <p style={MUTED}>Nothing missing in this period.</p> : (
              <Table head={["Make", "Calls wanting it", "Legacy matches", "Library"]}
                rows={s.draw_next.map((m) => [
                  m.make, m.calls_wanting, m.legacy_matches,
                  LIB_STATUS[m.status] ? <StatusBadge key="s" status={LIB_STATUS[m.status]} /> : <span key="s" style={MUTED}>not in library</span>,
                ])} />
            )}
          </div>
          <div className="card" style={{ padding: 14 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px" }}>Brand templates</p>
            {s.templates.length === 0 ? <p style={MUTED}>No brand logos generated in this period.</p> : (
              <Table head={["Template", "Logos made"]} rows={s.templates.map((x) => [x.template, x.calls])} />
            )}
            <p style={{ ...MUTED, margin: "8px 0 0" }}>Average {t.avg_brand_ms != null ? `${Math.round(t.avg_brand_ms)} ms` : "—"} per logo.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)" }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />{label}
    </span>
  );
}

function BarChart({ series }: { series: { key: string; vectorize: number; library: number; brand: number }[] }) {
  const W = 900, H = 180, PAD_L = 32, PAD_B = 22;
  const max = Math.max(1, ...series.map((d) => d.vectorize + d.brand));
  const bw = (W - PAD_L) / Math.max(1, series.length);
  const PAD_T = 12;
  const y = (v: number) => PAD_T + (H - PAD_B - PAD_T) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  const every = Math.max(1, Math.ceil(series.length / 10));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto" }} role="img" aria-label="calls chart">
      {ticks.map((tk) => (
        <g key={tk}>
          <line x1={PAD_L} x2={W} y1={y(tk)} y2={y(tk)} stroke="#e0e0e0" />
          <text x={PAD_L - 4} y={y(tk) + 4} fontSize="10" textAnchor="end" fill="#888">{tk}</text>
        </g>
      ))}
      {series.map((d, i) => {
        const x = PAD_L + i * bw + bw * 0.15;
        const w = Math.max(1, bw * 0.7);
        const plain = d.vectorize - d.library;
        return (
          <g key={d.key}>
            <title>{`${d.key}: ${d.vectorize} vectorize (${d.library} library on), ${d.brand} brand`}</title>
            <rect x={x} y={y(plain)} width={w} height={(H - PAD_B) - y(plain)} fill="#1976d2" />
            <rect x={x} y={y(plain + d.library)} width={w} height={y(plain) - y(plain + d.library)} fill="#64b5f6" />
            <rect x={x} y={y(d.vectorize + d.brand)} width={w} height={y(d.vectorize) - y(d.vectorize + d.brand)} fill="#ffa500" />
            {i % every === 0 && <text x={x + w / 2} y={H - 6} fontSize="10" textAnchor="middle" fill="#888">{d.key.slice(5)}</text>}
          </g>
        );
      })}
    </svg>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ background: "var(--bg-subtle)" }}>
          {head.map((h) => <th key={h} style={{ textAlign: "left", padding: "6px 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)" }}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
            {r.map((c, j) => <td key={j} style={{ padding: "6px 8px", color: j === 0 ? "var(--text-primary)" : "var(--text-secondary)" }}>{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
