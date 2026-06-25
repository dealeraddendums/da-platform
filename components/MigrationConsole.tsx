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
  inviteStatus: "not-invited" | "invited" | "stalled" | "expired" | "migrated";
  invitedAt: string | null;
  waveId: string | null;
  freshbooksStoppedAt: string | null;
  freshbooksStopPending: boolean;
  assignedTo: string | null;
  migrationStatus: string | null;
}
interface Wave { waveId: string; sentAt: string | null; sent: number; migrated: number; pending: number; }
interface Operator { id: string; name: string; }
interface Summary { total: number; ready: number; eligible: number; billingStaged: number; templateConfirmed: number; readyPool: number; settingsMissing: number; logoMissing: number; zeroInventory: number; freshbooksStopPending: number; unassigned: number; }
interface ApiResp { rows: Row[]; summary: Summary; operators: Operator[]; currentUserId: string; flagsColumnPresent: boolean; billingTemplatesLoaded: number; note: string; }
// Billing Pending tab rows — migrated dealers whose da-billing template is still
// paused. Fetched from /api/migration/billing-pending (NOT derived from readiness
// rows, which exclude migrated dealers — that's why the tab was always empty).
interface BillingPendingDealer { id: string; name: string; group_name: string | null; account_type: string | null; billing_customer_id: string | null; }

const NAVY = "#2a2b3c";

const Check = ({ ok, title }: { ok: boolean; title?: string }) => (
  <span title={title} style={{ color: ok ? "#2e7d32" : "#c62828", fontWeight: 700 }}>{ok ? "✓" : "✗"}</span>
);

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  "not-invited": { bg: "#f0f0f0", fg: "#78828c", label: "Not invited" },
  invited: { bg: "#e3f2fd", fg: "#1565c0", label: "Invited" },
  stalled: { bg: "#fff3e0", fg: "#b06a00", label: "Stalled" },
  expired: { bg: "#ffebee", fg: "#c62828", label: "Expired" },
  migrated: { bg: "#e8f5e9", fg: "#2e7d32", label: "Migrated" },
};
const StatusBadge = ({ status, invitedAt }: { status: string; invitedAt: string | null }) => {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE["not-invited"];
  const date = invitedAt && (status === "invited" || status === "stalled" || status === "expired") ? new Date(invitedAt).toLocaleDateString() : null;
  return <span title={date ? `invited ${date}` : s.label} style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, whiteSpace: "nowrap" }}>{s.label}{date ? ` · ${date}` : ""}</span>;
};

// Per-row billing activation state.
type ActivateState = { status: "idle" | "loading" | "done" | "error"; message?: string };

export default function MigrationConsole() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Tab: "readiness" (default) | "billing-pending"
  const [activeTab, setActiveTab] = useState<"readiness" | "billing-pending">("readiness");
  const [activateStates, setActivateStates] = useState<Record<string, ActivateState>>({});

  // wave selection (Ready rows only) + send
  const CAP = 100;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [waveResult, setWaveResult] = useState<{ summary: { requested: number; sent: number; failed: number; blocked: number }; failed: { name: string; error: string }[]; blocked: { name: string; reason: string }[] } | null>(null);

  // filters
  const [readyOnly, setReadyOnly] = useState(false);
  const [fbPending, setFbPending] = useState(false);
  const [stagedOnly, setStagedOnly] = useState(false);
  const [stagingId, setStagingId] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assignFilter, setAssignFilter] = useState(""); // "" all | "me" | "unassigned" | <operatorId>

  // wave summaries (13b step 3)
  const [waves, setWaves] = useState<Wave[]>([]);
  const [resendingId, setResendingId] = useState<string | null>(null);

  // operator assignment
  const [assignTarget, setAssignTarget] = useState("me"); // "me" | "unassign" | <operatorId>
  const [assigning, setAssigning] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const me = data?.currentUserId ?? "";
  const operators = data?.operators ?? [];
  const opName = (id: string | null) => !id ? null : (id === me ? "Me" : (operators.find((o) => o.id === id)?.name ?? "—"));

  // Dealers who completed /migrate but still need billing activated — fetched
  // from a dedicated endpoint (migrated dealers + paused da-billing template).
  const [billingPending, setBillingPending] = useState<BillingPendingDealer[]>([]);
  const [bpErr, setBpErr] = useState<string | null>(null);

  const loadBillingPending = async () => {
    setBpErr(null);
    try {
      const res = await fetch("/api/migration/billing-pending");
      const j = await res.json() as { dealers?: BillingPendingDealer[]; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Failed to load billing-pending");
      setBillingPending(j.dealers ?? []);
    } catch (e) {
      setBpErr(e instanceof Error ? e.message : "Failed to load billing-pending");
    }
  };

  async function activateBilling(dealerId: string) {
    setActivateStates((s) => ({ ...s, [dealerId]: { status: "loading" } }));
    try {
      const res = await fetch("/api/migration/activate-billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId }),
      });
      const j = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setActivateStates((s) => ({ ...s, [dealerId]: { status: "error", message: j.error ?? "Activation failed" } }));
      } else {
        setActivateStates((s) => ({ ...s, [dealerId]: { status: "done" } }));
      }
    } catch (e) {
      setActivateStates((s) => ({ ...s, [dealerId]: { status: "error", message: e instanceof Error ? e.message : "Activation failed" } }));
    }
  }

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
  const loadWaves = async () => {
    try { const r = await fetch("/api/migration/waves"); const j = await r.json(); if (r.ok) setWaves(j.waves ?? []); } catch { /* */ }
  };
  useEffect(() => { void load(); void loadWaves(); void loadBillingPending(); }, []);

  async function resend(row: Row) {
    if (!confirm(`Resend a migration invite to ${row.name}? A fresh one-time code goes to their contact (resets the stall clock).`)) return;
    setResendingId(row.id);
    try {
      const res = await fetch("/api/migration/resend", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerId: row.id }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Resend failed"); return; }
      alert(`Invite resent${j.email ? ` to ${j.email}` : ""}.`);
      await load();
    } catch { alert("Resend failed"); } finally { setResendingId(null); }
  }

  // Stage a dealer for an upcoming wave → migration_status='pending', which
  // FREEZES the DA Legacy ETL for that dealer (it stops overwriting their
  // settings before migration). Reflected optimistically; full reload after.
  async function stageDealer(row: Row) {
    if (!confirm(`Stage ${row.name} for migration? This freezes the ETL for this dealer (it stops overwriting their settings) until they're migrated.`)) return;
    setStagingId(row.id);
    try {
      const res = await fetch("/api/migration/stage-dealer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealer_id: row.id }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Stage failed"); return; }
      setData((d) => d && { ...d, rows: d.rows.map((r) => r.id === row.id ? { ...r, migrationStatus: "pending" } : r) });
    } catch { alert("Stage failed"); } finally { setStagingId(null); }
  }

  async function markFbStopped(row: Row, stopped: boolean) {
    try {
      const res = await fetch("/api/migration/freshbooks-stopped", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerId: row.id, stopped }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Update failed"); return; }
      setData((d) => d && { ...d, rows: d.rows.map((r) => r.id === row.id ? { ...r, freshbooksStoppedAt: j.freshbooks_stopped_at, freshbooksStopPending: r.inviteStatus === "migrated" && !j.freshbooks_stopped_at } : r) });
    } catch { alert("Update failed"); }
  }

  async function assignSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const assignTo = assignTarget === "me" ? me : assignTarget === "unassign" ? null : assignTarget;
    setAssigning(true);
    try {
      const res = await fetch("/api/migration/assign", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealerIds: ids, assignTo }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Assign failed"); return; }
      setSelected(new Set());
      await load();
    } catch { alert("Assign failed"); } finally { setAssigning(false); }
  }

  async function claimNext() {
    setClaiming(true);
    try {
      const res = await fetch("/api/migration/claim-next", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 25 }) });
      const j = await res.json();
      if (!res.ok) { alert(j.error ?? "Claim failed"); return; }
      alert(j.claimed > 0 ? `Claimed ${j.claimed} dealer${j.claimed === 1 ? "" : "s"} to your batch.` : (j.note ?? "Nothing to claim."));
      setAssignFilter("me");
      await load();
    } catch { alert("Claim failed"); } finally { setClaiming(false); }
  }

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
    if (fbPending) rows = rows.filter((r) => r.freshbooksStopPending);
    if (stagedOnly) rows = rows.filter((r) => r.migrationStatus === "pending");
    if (assignFilter === "me") rows = rows.filter((r) => r.assignedTo === me);
    else if (assignFilter === "unassigned") rows = rows.filter((r) => !r.assignedTo);
    else if (assignFilter) rows = rows.filter((r) => r.assignedTo === assignFilter);
    if (statusFilter) rows = rows.filter((r) => r.inviteStatus === statusFilter);
    if (group) rows = rows.filter((r) => r.groupName === group);
    if (state) rows = rows.filter((r) => r.state === state);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.dealer_id.toLowerCase().includes(q) || (r.groupName ?? "").toLowerCase().includes(q));
    }
    return rows;
  }, [data, readyOnly, fbPending, stagedOnly, assignFilter, me, statusFilter, group, state, search]);

  // "My batch" — dealers assigned to me, by stage.
  const myBatch = useMemo(() => {
    const mine = (data?.rows ?? []).filter((r) => r.assignedTo && r.assignedTo === me);
    return {
      total: mine.length,
      ready: mine.filter((r) => r.ready).length,
      invited: mine.filter((r) => r.inviteStatus === "invited" || r.inviteStatus === "stalled" || r.inviteStatus === "expired").length,
      migrated: mine.filter((r) => r.inviteStatus === "migrated").length,
    };
  }, [data, me]);

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
      invited: rows.filter((r) => r.inviteStatus === "invited").length,
      stalled: rows.filter((r) => r.inviteStatus === "stalled" || r.inviteStatus === "expired").length,
      migrated: rows.filter((r) => r.inviteStatus === "migrated").length,
      fbPending: rows.filter((r) => r.freshbooksStopPending).length,
      staged: rows.filter((r) => r.migrationStatus === "pending").length,
      unassigned: rows.filter((r) => r.eligible && !r.assignedTo).length,
    };
  }, [data]);

  const toggleSelect = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function sendWave() {
    // Invite only the READY subset of the selection (server blocks the rest anyway).
    const ids = (data?.rows ?? []).filter((r) => selected.has(r.id) && r.ready).map((r) => r.id);
    if (ids.length === 0) { alert("No Ready dealers selected."); return; }
    if (ids.length > CAP) { alert(`${ids.length} ready selected — over the cap of ${CAP}. Deselect some.`); return; }
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
    <div style={{ fontFamily: "’Roboto’, sans-serif" }}>
      {/* Tab bar */}
      {(() => {
        const tabBase: React.CSSProperties = { padding: "8px 20px", fontSize: 13, fontWeight: 600, border: "none", borderRadius: "6px 6px 0 0", cursor: "pointer", background: "transparent", color: "#78828c" };
        const tabActive: React.CSSProperties = { ...tabBase, background: "#fff", color: NAVY, borderBottom: "2px solid #1976d2" };
        return (
          <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e0e0e0", marginBottom: 16 }}>
            <button type="button" style={activeTab === "readiness" ? tabActive : tabBase} onClick={() => setActiveTab("readiness")}>
              Readiness
            </button>
            <button type="button" style={activeTab === "billing-pending" ? tabActive : tabBase} onClick={() => setActiveTab("billing-pending")}>
              Billing Pending{billingPending.length > 0 ? ` (${billingPending.length})` : ""}
            </button>
          </div>
        );
      })()}

      {activeTab === "readiness" && <>
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
        <div style={cardStyle}><div style={{ ...num, color: "#1565c0" }}>{s.invited}</div><div style={lbl}>Invited (pending)</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#b06a00" }}>{s.stalled}</div><div style={lbl}>Stalled / expired</div></div>
        <div style={cardStyle}><div style={{ ...num, color: "#2e7d32" }}>{s.migrated}</div><div style={lbl}>Migrated</div></div>
        <div style={cardStyle}><div style={{ ...num, color: s.fbPending ? "#c62828" : "#2e7d32" }}>{s.fbPending}</div><div style={lbl}>FreshBooks stop pending</div></div>
      </div>

      {/* Recent waves */}
      {waves.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>Recent waves</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {waves.slice(0, 6).map((w) => (
              <div key={w.waveId} style={{ display: "flex", gap: 12, fontSize: 13, alignItems: "center" }}>
                <span style={{ color: "#78828c", minWidth: 150 }}>{w.sentAt ? new Date(w.sentAt).toLocaleString() : w.waveId}</span>
                <span><strong>{w.sent}</strong> sent</span>
                <span style={{ color: "#2e7d32" }}>{w.migrated} migrated</span>
                <span style={{ color: "#b06a00" }}>{w.pending} pending</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* My batch + Claim next 25 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, background: "#eef6ff", border: "1px solid #bcdcff", borderRadius: 8, padding: "10px 14px", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: NAVY }}>My batch</span>
        <span style={{ fontSize: 13, color: "#55595c" }}>{myBatch.total} assigned · <strong style={{ color: "#2e7d32" }}>{myBatch.ready} ready</strong> · {myBatch.invited} invited · {myBatch.migrated} migrated</span>
        <span style={{ fontSize: 12, color: "#78828c" }}>· {s.unassigned} unassigned eligible</span>
        <button type="button" onClick={claimNext} disabled={claiming}
          title="Claim the next 25 unassigned eligible dealers (one-toggle-from-ready first)"
          style={{ marginLeft: "auto", height: 32, padding: "0 16px", border: "none", borderRadius: 6, background: claiming ? "#9bbfe6" : "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: claiming ? "default" : "pointer" }}>
          {claiming ? "Claiming…" : "Claim next 25"}
        </button>
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
        <select value={assignFilter} onChange={(e) => setAssignFilter(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }} title="Assigned to">
          <option value="">All owners</option>
          <option value="me">Me</option>
          <option value="unassigned">Unassigned</option>
          {operators.filter((o) => o.id !== me).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ height: 34, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
          <option value="">All statuses</option>
          <option value="not-invited">Not invited</option>
          <option value="invited">Invited</option>
          <option value="stalled">Stalled</option>
          <option value="expired">Expired</option>
          <option value="migrated">Migrated</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }}>
          <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} /> Ready only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }} title="Migrated dealers whose FreshBooks recurring still needs stopping">
          <input type="checkbox" checked={fbPending} onChange={(e) => setFbPending(e.target.checked)} /> FB stop pending
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#333", cursor: "pointer" }} title="Dealers staged for a wave (migration_status=pending) — ETL is frozen for them">
          <input type="checkbox" checked={stagedOnly} onChange={(e) => setStagedOnly(e.target.checked)} /> Staged{live.staged ? ` (${live.staged})` : ""}
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

      {/* Action bar — appears when rows are selected. Assign works on ALL
          selected; Send invites applies to the Ready subset (server blocks the
          rest). */}
      {selected.size > 0 && (() => {
        const selectedReady = (data?.rows ?? []).filter((r) => selected.has(r.id) && r.ready).length;
        const overCap = selectedReady > CAP;
        return (
          <div style={{ display: "flex", alignItems: "center", gap: 12, background: overCap ? "#fff3e0" : "#eef6ff", border: `1px solid ${overCap ? "#ffcc80" : "#bcdcff"}`, borderRadius: 8, padding: "10px 14px", marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: NAVY }}>{selected.size} selected{selectedReady !== selected.size ? ` (${selectedReady} ready)` : ""}</span>
            {/* Assign */}
            <select value={assignTarget} onChange={(e) => setAssignTarget(e.target.value)} style={{ height: 32, padding: "0 8px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 13 }}>
              <option value="me">Assign to me</option>
              {operators.filter((o) => o.id !== me).map((o) => <option key={o.id} value={o.id}>Assign to {o.name}</option>)}
              <option value="unassign">Unassign</option>
            </select>
            <button type="button" onClick={assignSelected} disabled={assigning}
              style={{ height: 32, padding: "0 14px", border: "1px solid #1976d2", borderRadius: 6, background: "#fff", color: "#1976d2", fontSize: 13, fontWeight: 600, cursor: assigning ? "default" : "pointer", opacity: assigning ? 0.6 : 1 }}>
              {assigning ? "Assigning…" : "Assign"}
            </button>
            {overCap && <span style={{ fontSize: 12, color: "#b06a00" }}>⚠ {selectedReady} ready &gt; cap {CAP}</span>}
            <button type="button" onClick={() => setSelected(new Set())} style={{ marginLeft: "auto", height: 32, padding: "0 10px", border: "1px solid #cccccc", borderRadius: 6, background: "#fff", fontSize: 13, cursor: "pointer" }}>Clear</button>
            <button type="button" onClick={sendWave} disabled={sending || selectedReady === 0 || overCap}
              title={selectedReady === 0 ? "No Ready dealers selected" : "Send the 13a OTP invite to selected Ready dealers"}
              style={{ height: 32, padding: "0 16px", border: "none", borderRadius: 6, background: sending || selectedReady === 0 || overCap ? "#9bbfe6" : "#1976d2", color: "#fff", fontSize: 13, fontWeight: 600, cursor: sending || selectedReady === 0 || overCap ? "default" : "pointer" }}>
              {sending ? "Sending…" : `Send invites (${Math.min(selectedReady, CAP)})`}
            </button>
          </div>
        );
      })()}

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
              <th style={th}>Owner</th>
              <th style={th}>Group</th>
              <th style={th}>State</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Billing</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Template</th>
              <th style={{ ...th, textAlign: "center" }} title="Hard gate">Eligible</th>
              <th style={{ ...th, textAlign: "center" }}>Ready?</th>
              <th style={{ ...th }}>Invite status</th>
              <th style={{ ...th, textAlign: "center" }} title="Informational — does NOT block Ready">Warnings</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} style={{ background: r.ready ? "#f4fbf4" : undefined }}>
                <td style={{ ...td, textAlign: "center" }}>
                  <input type="checkbox" checked={selected.has(r.id)} disabled={r.inviteStatus === "migrated"}
                    onChange={() => toggleSelect(r.id)}
                    title={r.inviteStatus === "migrated" ? "Already migrated" : "Select to assign and/or invite"}
                    style={{ cursor: r.inviteStatus === "migrated" ? "not-allowed" : "pointer" }} />
                </td>
                <td style={td}>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: "#9aa0a6" }}>{r.dealer_id}</div>
                </td>
                <td style={td}>
                  {r.assignedTo
                    ? <span style={{ fontSize: 12, fontWeight: r.assignedTo === me ? 600 : 400, color: r.assignedTo === me ? "#1565c0" : "#55595c" }}>{opName(r.assignedTo)}</span>
                    : <span style={{ color: "#9aa0a6", fontSize: 12 }}>Unassigned</span>}
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
                <td style={td}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <StatusBadge status={r.inviteStatus} invitedAt={r.invitedAt} />
                    {(r.inviteStatus === "invited" || r.inviteStatus === "stalled" || r.inviteStatus === "expired") && (
                      <button type="button" onClick={() => void resend(r)} disabled={resendingId === r.id}
                        title="Resend the migration invite (fresh code)"
                        style={{ fontSize: 11, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                        {resendingId === r.id ? "…" : "resend"}
                      </button>
                    )}
                    {r.migrationStatus === "pending" && (
                      <span title="Staged for a wave — DA Legacy ETL is frozen for this dealer (settings no longer overwritten)"
                        style={{ background: "#fff3e0", color: "#e65100", border: "1px solid #ffe0b2", fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" }}>
                        ⏸ Pending · ETL frozen
                      </span>
                    )}
                    {r.migrationStatus !== "pending" && r.inviteStatus !== "migrated" && (
                      <button type="button" onClick={() => void stageDealer(r)} disabled={stagingId === r.id}
                        title="Stage for migration — freezes the ETL so it stops overwriting this dealer's settings"
                        style={{ fontSize: 11, color: "#e65100", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                        {stagingId === r.id ? "…" : "stage"}
                      </button>
                    )}
                  </div>
                  {r.inviteStatus === "migrated" && (
                    <div style={{ fontSize: 11, marginTop: 4 }}>
                      {r.freshbooksStoppedAt
                        ? <span style={{ color: "#2e7d32" }} title={`stopped ${new Date(r.freshbooksStoppedAt).toLocaleString()}`}>FreshBooks stopped ✓ <button type="button" onClick={() => void markFbStopped(r, false)} style={{ fontSize: 10, color: "#9aa0a6", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>undo</button></span>
                        : <span style={{ color: "#b06a00" }}>FreshBooks stop pending <button type="button" onClick={() => void markFbStopped(r, true)} style={{ fontSize: 11, color: "#1976d2", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>mark stopped</button></span>}
                    </div>
                  )}
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
              <tr><td style={{ ...td, textAlign: "center", color: "#9aa0a6" }} colSpan={11}>No dealers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: "var(--text-muted, #78828c)", marginTop: 10 }}>{data.note}</p>
      </>}

      {activeTab === "billing-pending" && (() => {
        const bpTh: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid #e0e0e0", whiteSpace: "nowrap" };
        const bpTd: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "#333", borderBottom: "1px solid #f0f0f0", verticalAlign: "middle" };
        return (
          <div>
            {bpErr && (
              <div style={{ background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 8, padding: "12px 16px", fontSize: 13, marginBottom: 12 }}>
                {bpErr}
              </div>
            )}
            {billingPending.length === 0
              ? (
                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, padding: "24px 20px", textAlign: "center", color: "#78828c", fontSize: 14 }}>
                  All caught up — no billing activations pending.
                </div>
              )
              : (
                <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 8, overflow: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={bpTh}>Dealer</th>
                        <th style={bpTh}>Group</th>
                        <th style={bpTh}>Account type</th>
                        <th style={{ ...bpTh, width: 160 }}>Billing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {billingPending.map((r) => {
                        const aState = activateStates[r.id] ?? { status: "idle" };
                        return (
                          <tr key={r.id}>
                            <td style={bpTd}>
                              <div style={{ fontWeight: 600 }}>{r.name}</div>
                              <div style={{ fontSize: 11, color: "#9aa0a6" }} title={`Billing customer ${r.billing_customer_id ?? ""}`}>{r.billing_customer_id ?? "—"}</div>
                            </td>
                            <td style={bpTd}>{r.group_name ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                            <td style={bpTd}>{r.account_type ?? <span style={{ color: "#9aa0a6" }}>—</span>}</td>
                            <td style={bpTd}>
                              {aState.status === "done"
                                ? <span style={{ color: "#2e7d32", fontWeight: 600, fontSize: 13 }}>✓ Activated</span>
                                : aState.status === "error"
                                  ? <span style={{ color: "#c62828", fontSize: 12 }} title={aState.message}>Error: {aState.message}</span>
                                  : (
                                    <button
                                      type="button"
                                      disabled={aState.status === "loading"}
                                      onClick={() => void activateBilling(r.id)}
                                      style={{
                                        height: 30,
                                        padding: "0 14px",
                                        border: "none",
                                        borderRadius: 6,
                                        backgroundColor: aState.status === "loading" ? "#9bbfe6" : "#1976d2",
                                        color: "#fff",
                                        fontSize: 12,
                                        fontWeight: 600,
                                        cursor: aState.status === "loading" ? "default" : "pointer",
                                      }}
                                    >
                                      {aState.status === "loading" ? "Activating…" : "Activate Billing"}
                                    </button>
                                  )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </div>
        );
      })()}
    </div>
  );
}
