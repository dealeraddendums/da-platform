"use client";

import { useEffect, useMemo, useState } from "react";

interface Row {
  id: string;
  dealer_id: string;
  name: string;
  groupName: string | null;
  state: string | null;
  billingStaged: boolean;
  billingReason: string;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;
  ready: boolean;
  settingsMissing: boolean;
  logoMissing: boolean;
  zeroInventory: boolean;
  warnings: string[];
}
interface Summary { total: number; ready: number; eligible: number; billingStaged: number; templateConfirmed: number; readyPool: number; settingsMissing: number; logoMissing: number; zeroInventory: number; }
interface ApiResp { rows: Row[]; summary: Summary; flagsColumnPresent: boolean; billingTemplatesLoaded: number; note: string; }

const NAVY = "#2a2b3c";

const Check = ({ ok, title }: { ok: boolean; title?: string }) => (
  <span title={title} style={{ color: ok ? "#2e7d32" : "#c62828", fontWeight: 700 }}>{ok ? "✓" : "✗"}</span>
);

export default function MigrationConsole() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // wave selection (Ready rows only) + send
  const CAP = 100;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [waveResult, setWaveResult] = useState<{ summary: { requested: number; sent: number; failed: number; blocked: number }; failed: { name: string; error: string }[]; blocked: { name: string; reason: string }[] } | null>(null);

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
      // recompute ready locally — HARD gates only: billing && confirmed && eligible
      setData((d) => d && {
        ...d,
        rows: d.rows.map((r) => r.id === row.id
          ? { ...r, templateConfirmed: next, ready: r.billingStaged && next && r.eligible }
          : r),
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
      billingStaged: rows.filter((r) => r.billingStaged).length,
      templateConfirmed: rows.filter((r) => r.templateConfirmed).length,
      readyPool: rows.filter((r) => r.billingStaged && r.eligible).length,
    };
  }, [data]);

  const toggleSelect = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function sendWave() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (ids.length > CAP) { alert(`Select ${CAP} or fewer (weekly cap).`); return; }
    if (!confirm(`Send migration invites to ${ids.length} dealer${ids.length === 1 ? "" : "s"}? Each gets a one-time code to self-migrate. This does NOT change their billing.`)) return;
    setSending(true); setWaveResult(null);
    try {
      const res = await fetch("/api/migration/send-wave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerIds: ids }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Wave failed"); return; }
      setWaveResult({ summary: j.summary, failed: j.failed ?? [], blocked: j.blocked ?? [] });
      setSelected(new Set());
      await load(); // refresh
    } catch (e) { alert(e instanceof Error ? e.message : "Wave failed"); } finally { setSending(false); }
  }

  if (loading) return <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading readiness…</p>;
  if (err) return <p style={{ color: "#c62828", fontSize: 14 }}>Error: {err}</p>;
  if (!data) return null;

  const s = live;
  const cardStyle: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "12px 16px", minWidth: 120 };
  const num: React.CSSProperties = { fontSize: 22, fontWeight: 700, color: "var(--navy, #2a2b3c)" };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--text-muted, #78828c)", marginTop: 2 };
  const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "#333", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" };
  const warnChip: React.CSSProperties = { background: "#fff8e1", color: "#8a6d00", border: "1px solid #ffe082", borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap" };

  return (
    <div style={{ fontFamily: "'Roboto', sans-serif" }}>
      {!data.flagsColumnPresent && (
        <div style={{ background: "#fff8e1", border: "1px solid #ffe082", color: "#8a6d00", borderRadius: 6, padding: "10px 14px", marginBottom: 14, fontSize: 13 }}>
          ⚠️ The <code>template_confirmed</code> column isn’t applied yet — run migration{" "}
          <strong>100_migration_readiness.sql</strong> in the Supabase SQL editor to enable the toggle. The
          rest of the readiness view is live (template-confirmed shows as ✗ for everyone until then).
        </div>
      )}

      {/* Summary cards — HARD-gate definition (ready = billing ∩ template ∩ eligible) */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={cardStyle}><div style={{ ...num, color: "#2e7d32" }}>{s.ready}</div><div style={lbl}>Ready to invite</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#1976d2" }}>{s.readyPool}</div><div style={lbl}>One toggle from ready<br /><span style={{ fontSize: 10 }}>billing ∩ eligible</span></div></div>
        <div style={cardStyle}><div style={num}>{s.total}</div><div style={lbl}>Un-migrated dealers</div></div>
        <div style={cardStyle}><div style={num}>{s.eligible}</div><div style={lbl}>Eligible</div></div>
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
        <button
          type="button"
          onClick={() => setSelected((prev) => { const n = new Set(prev); const readyVisible = filtered.filter((r) => r.ready); const allSel = readyVisible.length > 0 && readyVisible.every((r) => n.has(r.id)); readyVisible.forEach((r) => allSel ? n.delete(r.id) : n.add(r.id)); return n; })}
          style={{ height: 34, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13, background: "#fff", cursor: "pointer" }}
        >
          Select all Ready (shown)
        </button>
        <span style={{ fontSize: 12, color: "var(--text-muted, #78828c)", marginLeft: "auto" }}>
          Showing {filtered.length} of {s.total}
        </span>
      </div>

      {/* Wave action bar — appears once Ready dealers are selected */}
      {selected.size > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, background: selected.size > CAP ? "#fff3e0" : "#eef6ff", border: `1px solid ${selected.size > CAP ? "#ffcc80" : "#bcdcff"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>{selected.size} selected</span>
          {selected.size > CAP
            ? <span style={{ fontSize: 13, color: "#b06a00" }}>⚠ Over the weekly cap of {CAP} — deselect {selected.size - CAP}.</span>
            : <span style={{ fontSize: 12, color: "#55595c" }}>Inviting doesn’t change billing — that happens on each dealer’s own confirm.</span>}
          <button type="button" onClick={() => setSelected(new Set())} style={{ marginLeft: "auto", height: 32, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" }}>Clear</button>
          <button type="button" onClick={sendWave} disabled={sending || selected.size > CAP}
            style={{ height: 32, padding: "0 16px", border: "none", borderRadius: 6, background: sending || selected.size > CAP ? "#9bbfe6" : "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: sending || selected.size > CAP ? "default" : "pointer" }}>
            {sending ? "Sending…" : `Send migration invites (${Math.min(selected.size, CAP)})`}
          </button>
        </div>
      )}

      {/* Last wave result */}
      {waveResult && (
        <div style={{ background: "#f1faf2", border: "1px solid #cfe8d2", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#2e7d32" }}>
          Wave sent — <strong>{waveResult.summary.sent}</strong> invited{waveResult.summary.failed ? `, ${waveResult.summary.failed} failed` : ""}{waveResult.summary.blocked ? `, ${waveResult.summary.blocked} blocked (not ready)` : ""}.
          {waveResult.failed.length > 0 && <div style={{ color: "#c62828", marginTop: 4 }}>Failed: {waveResult.failed.map((f) => `${f.name} (${f.error})`).join("; ")}</div>}
          {waveResult.blocked.length > 0 && <div style={{ color: "#b06a00", marginTop: 4 }}>Blocked: {waveResult.blocked.map((b) => `${b.name} (${b.reason})`).join("; ")}</div>}
        </div>
      )}

      {/* Table */}
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 34, textAlign: "center" }} title="Select Ready dealers for a wave"> </th>
              <th style={th}>Dealer</th>
              <th style={th}>Group</th>
              <th style={th}>State</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Billing</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Template</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Eligible</th>
              <th style={{ ...th, textAlign: "center" }}>Ready?</th>
              <th style={{ ...th, textAlign: "center" }} title="Informational — does NOT block Ready">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={{ background: r.ready ? "#f4fbf4" : undefined }}>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="checkbox" checked={selected.has(r.id)} disabled={!r.ready}
                    onChange={() => toggleSelect(r.id)}
                    title={r.ready ? "Select for a migration wave" : "Only Ready dealers can be invited"}
                    style={{ cursor: r.ready ? "pointer" : "not-allowed" }} />
                </td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: "#9aa0a6" }}>{r.dealer_id}</div>
                </td>
                <td style={td}>{r.groupName ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                <td style={td}>{r.state ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
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
                <td style={{ ...td, textAlign: "center" }}>
                  {r.warnings.length === 0
                    ? <span style={{ color: "#cfd8dc" }}>—</span>
                    : <span title={`Non-blocking: ${r.warnings.join(", ")}`} style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "center" }}>
                        {r.logoMissing && <span style={warnChip}>no logo</span>}
                        {r.settingsMissing && <span style={warnChip}>no settings</span>}
                        {r.zeroInventory && <span style={warnChip}>no products</span>}
                      </span>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td style={{ ...td, textAlign: "center", color: "#9aa0a6" }} colSpan={9}>No dealers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted, #78828c)", marginTop: 10 }}>{data.note}</p>
    </div>
  );
}
