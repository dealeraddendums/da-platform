"use client";

import { useEffect, useMemo, useState } from "react";

interface Row {
  id: string;
  dealer_id: string;
  name: string;
  groupName: string | null;
  state: string | null;
  etlComplete: boolean;
  etlMissing: string[];
  billingStaged: boolean;
  billingReason: string;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;
  ready: boolean;
}
interface Summary { total: number; ready: number; eligible: number; etlComplete: number; billingStaged: number; templateConfirmed: number; }
interface ApiResp { rows: Row[]; summary: Summary; flagsColumnPresent: boolean; billingTemplatesLoaded: number; note: string; }

const Check = ({ ok, title }: { ok: boolean; title?: string }) => (
  <span title={title} style={{ color: ok ? "#2e7d32" : "#c62828", fontWeight: 700 }}>{ok ? "✓" : "✗"}</span>
);

export default function MigrationConsole() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // filters
  const [readyOnly, setReadyOnly] = useState(false);
  const [group, setGroup] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/migration/readiness");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setData(json as ApiResp);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const toggleConfirmed = async (row: Row) => {
    if (!data?.flagsColumnPresent) return;
    setSavingId(row.id);
    const next = !row.templateConfirmed;
    try {
      const res = await fetch("/api/migration/template-confirmed", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealerId: row.id, confirmed: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      // recompute ready locally (ready = etl && billing && confirmed && eligible)
      setData((d) => d && {
        ...d,
        rows: d.rows.map((r) => r.id === row.id
          ? { ...r, templateConfirmed: next, ready: r.etlComplete && r.billingStaged && next && r.eligible }
          : r),
        summary: { ...d.summary }, // recomputed below via useMemo-free approach
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSavingId(null);
    }
  };

  const groups = useMemo(() => {
    const s = new Set<string>();
    data?.rows.forEach((r) => { if (r.groupName) s.add(r.groupName); });
    return Array.from(s).sort();
  }, [data]);
  const states = useMemo(() => {
    const s = new Set<string>();
    data?.rows.forEach((r) => { if (r.state) s.add(r.state); });
    return Array.from(s).sort();
  }, [data]);

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (readyOnly) rows = rows.filter((r) => r.ready);
    if (group) rows = rows.filter((r) => r.groupName === group);
    if (state) rows = rows.filter((r) => r.state === state);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.dealer_id.toLowerCase().includes(q) || (r.groupName ?? "").toLowerCase().includes(q));
    }
    return rows;
  }, [data, readyOnly, group, state, search]);

  // live summary recomputed from rows so toggling template-confirmed updates the cards
  const live = useMemo(() => {
    const rows = data?.rows ?? [];
    return {
      total: rows.length,
      ready: rows.filter((r) => r.ready).length,
      eligible: rows.filter((r) => r.eligible).length,
      etlComplete: rows.filter((r) => r.etlComplete).length,
      billingStaged: rows.filter((r) => r.billingStaged).length,
      templateConfirmed: rows.filter((r) => r.templateConfirmed).length,
    };
  }, [data]);

  if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading readiness…</p>;
  if (err) return <p style={{ color: "#c62828", fontSize: 14 }}>Error: {err}</p>;
  if (!data) return null;

  const s = live;
  const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "12px 16px", minWidth: 120 };
  const num: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: "var(--navy, #2a2b3c)" };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--text-muted, #78828c)", marginTop: 2 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "#333", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" };

  return (
    <div style={{ fontFamily: "'Roboto', sans-serif" }}>
      {!data.flagsColumnPresent && (
        <div style={{ background: "#fff8e1", border: "1px solid #ffe082", color: "#8a6d00", borderRadius: 6, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
          ⚠️ The <code>template_confirmed</code> column isn’t applied yet — run migration{" "}
          <strong>100_migration_readiness.sql</strong> in the Supabase SQL editor to enable the toggle. The
          rest of the readiness view is live (template-confirmed shows as ✗ for everyone until then).
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={cardStyle}><div style={{ ...num, color: "#2e7d32" }}>{s.ready}</div><div style={lbl}>Ready to invite</div></div>
        <div style={cardStyle}><div style={num}>{s.total}</div><div style={lbl}>Un-migrated dealers</div></div>
        <div style={cardStyle}><div style={num}>{s.eligible}</div><div style={lbl}>Eligible</div></div>
        <div style={cardStyle}><div style={num}>{s.etlComplete}</div><div style={lbl}>ETL complete</div></div>
        <div style={cardStyle}><div style={num}>{s.billingStaged}</div><div style={lbl}>Billing staged</div></div>
        <div style={cardStyle}><div style={num}>{s.templateConfirmed}</div><div style={lbl}>Template confirmed</div></div>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name / ID / group…"
          style={{ height: 34, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13, minWidth: 240 }} />
        <select value={group} onChange={(e) => setGroup(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All states</option>
          {states.map((st) => <option key={st} value={st}>{st}</option>)}
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }}>
          <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} /> Ready only
        </label>
        <span style={{ fontSize: 12, color: "var(--text-muted, #78828c)", marginLeft: "auto" }}>
          Showing {filtered.length} of {s.total}
        </span>
      </div>

      {/* Table */}
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Dealer</th>
              <th style={th}>Group</th>
              <th style={th}>State</th>
              <th style={{ ...th, textAlign: "center" }}>ETL</th>
              <th style={{ ...th, textAlign: "center" }}>Billing</th>
              <th style={{ ...th, textAlign: "center" }}>Template</th>
              <th style={{ ...th, textAlign: "center" }}>Eligible</th>
              <th style={{ ...th, textAlign: "center" }}>Ready?</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={{ background: r.ready ? "#f4fbf4" : undefined }}>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: "#9aa0a6" }}>{r.dealer_id}</div>
                </td>
                <td style={td}>{r.groupName ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                <td style={td}>{r.state ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                <td style={{ ...td, textAlign: "center" }}><Check ok={r.etlComplete} title={r.etlMissing.length ? `Missing: ${r.etlMissing.join(", ")}` : "complete"} /></td>
                <td style={{ ...td, textAlign: "center" }}><Check ok={r.billingStaged} title={r.billingReason} /></td>
                <td style={{ ...td, textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={r.templateConfirmed}
                    disabled={!data.flagsColumnPresent || savingId === r.id}
                    onChange={() => void toggleConfirmed(r)}
                    title={data.flagsColumnPresent ? "Operator: template applied + reviewed" : "Apply migration 100 to enable"}
                    style={{ cursor: data.flagsColumnPresent ? "pointer" : "not-allowed" }}
                  />
                </td>
                <td style={{ ...td, textAlign: "center" }}><Check ok={r.eligible} title={r.eligibleReason} /></td>
                <td style={{ ...td, textAlign: "center" }}>
                  {r.ready
                    ? <span style={{ background: "#2e7d32", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20 }}>READY</span>
                    : <span style={{ color: "#9aa0a6", fontSize: 12 }}>—</span>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td style={{ ...td, textAlign: "center", color: "#9aa0a6" }} colSpan={8}>No dealers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted, #78828c)", marginTop: 10 }}>{data.note}</p>
    </div>
  );
}
