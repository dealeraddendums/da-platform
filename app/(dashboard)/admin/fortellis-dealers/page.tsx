"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

interface FortellisRow {
  id: number;
  dealer_name: string;
  subscription_id: string;
  web_id: string | null;
  dealer_code: string | null;
  dealer_id: string | null;
  is_new: boolean;
  enabled: boolean;
  last_delta_at: string | null;
  last_full_sync_at: string | null;
  last_status: string | null;
}

interface Subscription {
  subscriptionId: string;
  orgName?: string;
  status?: string;
  environment?: string;
}

interface FleetError { subscription_id: string; dealer_name: string; error: string; error_type: string; }
interface FleetStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_updated: number;
  total_vehicles_sold: number;
  errors: FleetError[];
}

interface Health { state: "up" | "down"; since?: string; last_error?: string; last_ok_at?: string }

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", height: 36, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 13, color: "#333" };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 };

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default function FortellisDealersPage() {
  const [rows, setRows] = useState<FortellisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editRow, setEditRow] = useState<FortellisRow | "new" | null>(null);
  const [deleteRow, setDeleteRow] = useState<FortellisRow | null>(null);
  const [search, setSearch] = useState("");
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string; requestId?: string; httpStatus?: number } | null>>({});
  const [testing, setTesting] = useState<Record<number, boolean>>({});
  const [syncing, setSyncing] = useState<Record<number, boolean>>({});
  const [importing, setImporting] = useState<Record<number, boolean>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [fleetStatus, setFleetStatus] = useState<FleetStatus | null>(null);
  const [fleetStalled, setFleetStalled] = useState(false);
  const [rowMsg, setRowMsg] = useState<Record<number, { ok: boolean; msg: string } | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/fortellis-dealers");
    if (res.ok) { const j = await res.json() as { data: FortellisRow[] }; setRows(j.data); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const loadHealth = useCallback(async () => {
    const res = await fetch("/api/admin/fortellis/health", { cache: "no-store" });
    if (res.ok) { const j = await res.json() as { health: Health }; setHealth(j.health); }
  }, []);
  useEffect(() => { void loadHealth(); }, [loadHealth]);

  // ── Fleet status self-chaining poll ─────────────────────────────────────────
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCancelledRef = useRef(false);
  const pollFleetStatus = useCallback(async () => {
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
    try {
      const res = await fetch("/api/admin/fortellis/full-sync/status", { cache: "no-store" });
      if (pollCancelledRef.current) return;
      if (!res.ok) { pollTimerRef.current = setTimeout(() => { void pollFleetStatus(); }, 3000); return; }
      const j = await res.json() as { status: FleetStatus | null; stalled?: boolean };
      if (pollCancelledRef.current) return;
      setFleetStatus(j.status);
      setFleetStalled(Boolean(j.stalled));
      if (j.status?.status === "running" && !j.stalled) {
        pollTimerRef.current = setTimeout(() => { void pollFleetStatus(); }, 1000);
      } else {
        void loadHealth();
      }
    } catch {
      if (!pollCancelledRef.current) pollTimerRef.current = setTimeout(() => { void pollFleetStatus(); }, 3000);
    }
  }, [loadHealth]);
  useEffect(() => {
    pollCancelledRef.current = false;
    void pollFleetStatus();
    return () => { pollCancelledRef.current = true; if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, [pollFleetStatus]);

  async function dismissFleetStatus() {
    await fetch("/api/admin/fortellis/full-sync/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) });
    setFleetStatus(null); setFleetStalled(false);
  }

  async function runTest(r: FortellisRow) {
    setTesting(p => ({ ...p, [r.id]: true }));
    setTestResult(p => ({ ...p, [r.id]: null }));
    try {
      const res = await fetch("/api/admin/fortellis/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: r.subscription_id, web_id: r.web_id, dealer_code: r.dealer_code }),
      });
      const j = await res.json() as { success?: boolean; count?: number; error?: string; request_id?: string; http_status?: number };
      setTestResult(p => ({ ...p, [r.id]: j.success
        ? { ok: true, msg: `Connection successful — ${j.count ?? 0} vehicles found`, requestId: j.request_id, httpStatus: j.http_status }
        : { ok: false, msg: `Connection failed — ${j.error ?? "unknown error"}`, requestId: j.request_id, httpStatus: j.http_status } }));
      void loadHealth();
    } finally { setTesting(p => ({ ...p, [r.id]: false })); }
  }

  async function runImport(r: FortellisRow) {
    setImporting(p => ({ ...p, [r.id]: true }));
    setRowMsg(p => ({ ...p, [r.id]: null }));
    try {
      const res = await fetch("/api/admin/fortellis/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) });
      const j = await res.json() as { success?: boolean; vehicles_imported?: number; vehicles_skipped?: number; error?: string };
      if (j.success) {
        setRowMsg(p => ({ ...p, [r.id]: { ok: true, msg: `Imported ${j.vehicles_imported ?? 0} vehicles (${j.vehicles_skipped ?? 0} skipped)` } }));
        setRows(prev => prev.map(x => x.id === r.id ? { ...x, is_new: false } : x));
      } else {
        setRowMsg(p => ({ ...p, [r.id]: { ok: false, msg: j.error ?? "Import failed" } }));
      }
      void loadHealth();
    } finally { setImporting(p => ({ ...p, [r.id]: false })); }
  }

  async function runFullSync(r: FortellisRow) {
    setSyncing(p => ({ ...p, [r.id]: true }));
    setRowMsg(p => ({ ...p, [r.id]: null }));
    try {
      const res = await fetch("/api/admin/fortellis/full-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) });
      const j = await res.json() as { success?: boolean; vehicles_imported?: number; vehicles_updated?: number; vehicles_sold?: number; error?: string };
      setRowMsg(p => ({ ...p, [r.id]: j.success
        ? { ok: true, msg: `Synced — ${j.vehicles_imported ?? 0} added, ${j.vehicles_updated ?? 0} updated, ${j.vehicles_sold ?? 0} sold` }
        : { ok: false, msg: j.error ?? "Full sync failed" } }));
      void load();
      void loadHealth();
    } finally { setSyncing(p => ({ ...p, [r.id]: false })); }
  }

  async function startFleet() {
    const res = await fetch("/api/admin/fortellis/full-sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fleet: true }) });
    if (res.ok) {
      const j = await res.json() as { started_at?: string; total_dealers?: number };
      setFleetStatus({ status: "running", started_at: j.started_at ?? new Date().toISOString(), total_dealers: j.total_dealers ?? 0, completed: 0, failed: 0, current_dealer: null, total_vehicles_imported: 0, total_vehicles_updated: 0, total_vehicles_sold: 0, errors: [] });
      setFleetStalled(false);
      void pollFleetStatus();
    } else {
      const j = await res.json().catch(() => ({})) as { error?: string };
      alert(j.error ?? "Failed to start Fortellis update");
    }
  }

  async function removeDealer(r: FortellisRow) {
    const res = await fetch(`/api/admin/fortellis-dealers/${r.id}`, { method: "DELETE" });
    if (res.ok) { setRows(prev => prev.filter(x => x.id !== r.id)); setDeleteRow(null); }
  }

  const filtered = rows
    .filter(r => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (r.dealer_name ?? "").toLowerCase().includes(q)
        || (r.subscription_id ?? "").toLowerCase().includes(q)
        || (r.dealer_id ?? "").toLowerCase().includes(q)
        || (r.web_id ?? "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (a.is_new !== b.is_new) return a.is_new ? -1 : 1;
      return (a.dealer_name ?? "").localeCompare(b.dealer_name ?? "");
    });

  const fleetRunning = fleetStatus?.status === "running" && !fleetStalled;

  return (
    <div>
      <PageHeader
        title="Fortellis Dealers"
        subtitle={`${rows.length} dealer${rows.length === 1 ? "" : "s"} connected via Fortellis (CDK PIP replacement)`}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => void startFleet()}
              disabled={fleetRunning}
              style={{ padding: "8px 16px", background: "#ffa500", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: fleetRunning ? "not-allowed" : "pointer", opacity: fleetRunning ? 0.6 : 1, fontFamily: "inherit" }}
            >
              Fortellis Update
            </button>
            <button className="btn btn-primary" onClick={() => setEditRow("new")}>+ Add Dealer</button>
          </div>
        }
      />

      <HealthBanner health={health} />

      {fleetStatus && (
        <FleetBanner status={fleetStatus} stalled={fleetStalled} onDismiss={() => void dismissFleetStatus()} />
      )}

      <div className="card p-4 mb-4">
        <input type="text" className="input w-full" placeholder="Search by name, Subscription-Id, webId, or dealer_id…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            {rows.length === 0 ? "No Fortellis dealers connected yet." : "No dealers match your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Dealer Name", "Subscription ID", "Matched Dealer", "New", "Last Delta", "Last Full Sync", "Actions"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const tr = testResult[r.id];
                const rm = rowMsg[r.id];
                const busy = testing[r.id] || syncing[r.id] || importing[r.id];
                return (
                  <>
                    <tr key={r.id} style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none", opacity: r.enabled ? 1 : 0.55 }}>
                      <td className="px-4 py-2.5"><span style={{ color: "var(--text-primary)" }}>{r.dealer_name}</span>{!r.enabled && <span style={{ marginLeft: 6, fontSize: 10, color: "#999" }}>(disabled)</span>}</td>
                      <td className="px-4 py-2.5"><span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{r.subscription_id}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono text-xs" style={{ color: r.dealer_id ? "var(--text-secondary)" : "#c62828" }}>{r.dealer_id ?? "unmatched"}</span></td>
                      <td className="px-4 py-2.5">
                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: r.is_new ? "#e8f5e9" : "#fafafa", color: r.is_new ? "#2e7d32" : "#78828c", border: `1px solid ${r.is_new ? "#c8e6c9" : "#e0e0e0"}` }}>
                          {r.is_new ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5"><span className="text-xs" style={{ color: "var(--text-secondary)" }}>{fmtDate(r.last_delta_at)}</span></td>
                      <td className="px-4 py-2.5"><span className="text-xs" style={{ color: "var(--text-secondary)" }}>{fmtDate(r.last_full_sync_at)}</span></td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={() => void runTest(r)} disabled={busy} style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #1976d2", color: "#1976d2", background: "#fff", borderRadius: 4, cursor: busy ? "wait" : "pointer", fontFamily: "inherit" }}>{testing[r.id] ? "Testing…" : "Test"}</button>
                          {r.is_new ? (
                            <button onClick={() => void runImport(r)} disabled={busy} style={{ fontSize: 11, padding: "4px 10px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, cursor: busy ? "wait" : "pointer", fontFamily: "inherit", fontWeight: 600 }}>{importing[r.id] ? "Importing…" : "Import"}</button>
                          ) : (
                            <button onClick={() => void runFullSync(r)} disabled={busy} style={{ fontSize: 11, padding: "4px 10px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: busy ? "wait" : "pointer", fontFamily: "inherit", fontWeight: 600 }}>{syncing[r.id] ? "Syncing…" : "Full Sync"}</button>
                          )}
                          <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setEditRow(r)}>Edit</button>
                          <button className="text-xs" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setDeleteRow(r)}>Remove</button>
                        </div>
                      </td>
                    </tr>
                    {(tr || rm) && (
                      <tr style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <td colSpan={7} className="px-4 py-2 text-xs" style={{ background: (tr ?? rm)!.ok ? "#e8f5e9" : "#ffebee", color: (tr ?? rm)!.ok ? "#2e7d32" : "#c62828" }}>
                          {(tr ?? rm)!.ok ? "✓" : "✕"} {(tr ?? rm)!.msg}
                          <button onClick={() => { setTestResult(p => ({ ...p, [r.id]: null })); setRowMsg(p => ({ ...p, [r.id]: null })); }} style={{ background: "none", border: "none", color: "inherit", marginLeft: 12, cursor: "pointer", fontSize: 12, opacity: 0.6 }}>dismiss</button>
                          {tr?.requestId && (
                            <div className="font-mono" style={{ fontSize: 11, marginTop: 4, opacity: 0.85, display: "flex", alignItems: "center", gap: 6 }}>
                              <span>HTTP {tr.httpStatus ?? "—"} · Request-Id {tr.requestId}</span>
                              <CopyChip text={tr.requestId} />
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {editRow !== null && (
        <EditModal initial={editRow === "new" ? null : editRow} onClose={() => setEditRow(null)} onSaved={() => { setEditRow(null); void load(); }} />
      )}
      {deleteRow && (
        <DeleteModal row={deleteRow} onClose={() => setDeleteRow(null)} onConfirm={() => void removeDealer(deleteRow)} />
      )}
    </div>
  );
}

// ── Copy-to-clipboard chip (Request-Id support-ticket helper) ─────────────────
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy Request-Id"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 11, color: "inherit", opacity: copied ? 1 : 0.7, lineHeight: 1, fontFamily: "inherit" }}
    >
      {copied ? "✓ copied" : "⧉ copy"}
    </button>
  );
}

// ── Health banner ─────────────────────────────────────────────────────────────
function HealthBanner({ health }: { health: Health | null }) {
  if (!health) return null;
  const down = health.state === "down";
  return (
    <div className="card p-3 mb-4" style={{ background: down ? "#ffebee" : "#e8f5e9", border: `1px solid ${down ? "#ffcdd2" : "#c8e6c9"}` }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: down ? "#c62828" : "#2e7d32" }}>
        {down ? (
          <>🔴 Fortellis API DOWN{health.since ? ` since ${fmtDate(health.since)}` : ""}{health.last_error ? ` — ${health.last_error}` : ""}</>
        ) : (
          <>🟢 API healthy{health.last_ok_at ? ` — last successful call ${fmtDate(health.last_ok_at)}` : ""}</>
        )}
      </div>
    </div>
  );
}

// ── Fleet progress / result banner ──────────────────────────────────────────────
function FleetBanner({ status, stalled, onDismiss }: { status: FleetStatus; stalled: boolean; onDismiss: () => void }) {
  const running = status.status === "running" && !stalled;
  const [, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);

  if (running) {
    const pct = status.total_dealers > 0 ? Math.round((status.completed / status.total_dealers) * 100) : 0;
    return (
      <div className="card p-4 mb-4" style={{ background: "#fff8e1", border: "1px solid #ffe082" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#7a5c00", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Fortellis Update in progress — {status.completed} of {status.total_dealers}{status.current_dealer ? ` — ${status.current_dealer}…` : ""}
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#7a5c00" }}>{pct}%</div>
        </div>
        <div style={{ height: 8, background: "#fff", borderRadius: 4, overflow: "hidden", border: "1px solid #ffe082" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "repeating-linear-gradient(45deg, #ffa500 0 8px, #ffb733 8px 16px)", transition: "width 0.5s ease" }} />
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#7a5c00", flexWrap: "wrap" }}>
          <span><strong>Added:</strong> {status.total_vehicles_imported.toLocaleString()}</span>
          <span><strong>Updated:</strong> {status.total_vehicles_updated.toLocaleString()}</span>
          <span><strong>Sold:</strong> {status.total_vehicles_sold.toLocaleString()}</span>
          {status.failed > 0 && <span style={{ color: "#c62828" }}><strong>Failed:</strong> {status.failed}</span>}
        </div>
      </div>
    );
  }

  const failedAll = status.status === "failed";
  const tone = failedAll ? "#ffebee" : stalled ? "#fff8e1" : "#e8f5e9";
  const border = failedAll ? "#ffcdd2" : stalled ? "#ffe082" : "#c8e6c9";
  const color = failedAll ? "#c62828" : stalled ? "#7a5c00" : "#2e7d32";
  const succeeded = status.total_dealers - status.failed;

  return (
    <div className="card p-4 mb-4" style={{ background: tone, border: `1px solid ${border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 13, color, lineHeight: 1.7, flex: 1, minWidth: 0 }}>
          {stalled ? (
            <strong>Fortellis Update stalled — no activity for over 5 minutes. The worker likely hung or restarted mid-run.</strong>
          ) : (
            <strong>Fortellis Update complete — {status.total_vehicles_imported.toLocaleString()} added, {status.total_vehicles_updated.toLocaleString()} updated, {status.total_vehicles_sold.toLocaleString()} sold across {succeeded} dealer{succeeded === 1 ? "" : "s"}{status.failed > 0 ? `. ${status.failed} failed.` : "."}</strong>
          )}
          {status.errors.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Errors ({status.errors.length})</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color, maxHeight: 220, overflowY: "auto" }}>
                {status.errors.slice(0, 50).map((e, i) => (
                  <li key={i}><strong>{e.dealer_name || e.subscription_id}</strong> — {e.error}{e.error_type === "auth_401" ? " (unauthorized — email sent to support)" : ""}</li>
                ))}
                {status.errors.length > 50 && <li style={{ listStyle: "none", fontStyle: "italic" }}>…and {status.errors.length - 50} more.</li>}
              </ul>
            </div>
          )}
        </div>
        <button onClick={onDismiss} style={{ background: "none", border: "none", color, cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0, whiteSpace: "nowrap" }}>Dismiss</button>
      </div>
    </div>
  );
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────
interface DealerHit { id: string; name: string; dealer_id: string }
interface Autofill { dealer_id: string; dealer_name: string; dealer_code: string | null; web_id: string | null; cdk_fed: boolean; already_added: boolean }

function EditModal({ initial, onClose, onSaved }: { initial: FortellisRow | null; onClose: () => void; onSaved: () => void }) {
  const [dealerName, setDealerName] = useState(initial?.dealer_name ?? "");
  const [subscriptionId, setSubscriptionId] = useState(initial?.subscription_id ?? "");
  const [webId, setWebId] = useState(initial?.web_id ?? "");
  const [dealerCode, setDealerCode] = useState(initial?.dealer_code ?? "");
  const [dealerId, setDealerId] = useState(initial?.dealer_id ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [subsError, setSubsError] = useState<string | null>(null);
  // Dealer picker state (Add mode only — Edit keeps the existing linked dealer)
  const [dealerQuery, setDealerQuery] = useState("");
  const [dealerHits, setDealerHits] = useState<DealerHit[]>([]);
  const [noMatch, setNoMatch] = useState(false);
  const [dealerPicked, setDealerPicked] = useState(Boolean(initial?.dealer_id));
  const [resolving, setResolving] = useState(false);
  const [cdkFed, setCdkFed] = useState(false);
  const [alreadyAdded, setAlreadyAdded] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/admin/fortellis/subscriptions");
      if (res.ok) { const j = await res.json() as { subscriptions: Subscription[] }; setSubs(j.subscriptions); }
      else { const j = await res.json().catch(() => ({})) as { error?: string }; setSubsError(j.error ?? "Could not load subscriptions"); }
    })();
  }, []);

  // Debounced dealer search (Add mode). Skip once a dealer is chosen.
  useEffect(() => {
    setNoMatch(false);
    if (initial || dealerPicked || dealerQuery.trim().length < 2) { setDealerHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/dealers?q=${encodeURIComponent(dealerQuery.trim())}&per_page=12`);
        const j = await res.json() as { data?: DealerHit[] };
        const hits = (j.data ?? []).map(d => ({ id: d.id, name: d.name, dealer_id: d.dealer_id }));
        // CDK-fed dealers (3PA…) first — those are the ones being converted.
        hits.sort((a, b) => {
          const aC = /^3PA/i.test(a.dealer_id) ? 0 : 1;
          const bC = /^3PA/i.test(b.dealer_id) ? 0 : 1;
          return aC !== bC ? aC - bC : a.name.localeCompare(b.name);
        });
        setDealerHits(hits.slice(0, 12));
        // Zero-match feedback: covers both typed queries and the orgName cross-fill
        // seed (which often isn't a dealership name and silently matched nothing).
        setNoMatch(hits.length === 0);
      } catch { setDealerHits([]); }
    }, 300);
    return () => clearTimeout(t);
  }, [dealerQuery, dealerPicked, initial]);

  async function pickDealer(hit: DealerHit) {
    setDealerPicked(true);
    setDealerHits([]);
    setDealerQuery(hit.name);
    setDealerName(hit.name);
    setDealerId(hit.dealer_id);
    setError(null);
    setResolving(true);
    try {
      const res = await fetch(`/api/admin/fortellis/dealer-autofill?dealer_id=${encodeURIComponent(hit.dealer_id)}`);
      if (res.ok) {
        const { autofill } = await res.json() as { autofill: Autofill };
        setDealerName(autofill.dealer_name);
        setDealerCode(autofill.dealer_code ?? "");
        setCdkFed(autofill.cdk_fed);
        setAlreadyAdded(autofill.already_added);
        if (autofill.web_id) setWebId(autofill.web_id);
        // Cross-fill: if a subscription's orgName matches this dealer, preselect it.
        if (!subscriptionId && subs) {
          const m = subs.find(s => (s.orgName ?? "").trim().toLowerCase() === autofill.dealer_name.trim().toLowerCase());
          if (m) setSubscriptionId(m.subscriptionId);
        }
      }
    } finally { setResolving(false); }
  }

  function clearDealer() {
    setDealerPicked(false);
    setDealerId(""); setDealerName(""); setDealerCode(""); setWebId("");
    setCdkFed(false); setAlreadyAdded(false);
    setDealerQuery("");
  }

  async function save() {
    setError(null);
    if (!dealerId.trim()) { setError("Select a dealer"); return; }
    if (!subscriptionId.trim()) { setError("A Subscription-Id is required"); return; }
    if (!initial && alreadyAdded) { setError("That dealer already has a Fortellis connection"); return; }
    setSaving(true);
    const url = initial ? `/api/admin/fortellis-dealers/${initial.id}` : "/api/admin/fortellis-dealers";
    const method = initial ? "PATCH" : "POST";
    const res = await fetch(url, {
      method, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_name: dealerName, subscription_id: subscriptionId, web_id: webId, dealer_code: dealerCode, dealer_id: dealerId, enabled }),
    });
    setSaving(false);
    if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: string }; setError(j.error ?? "Save failed"); return; }
    onSaved();
  }

  return (
    <Modal title={initial ? "Edit Fortellis Dealer" : "Add Fortellis Dealer"} onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}

      {/* Dealer — searchable picker (Add) or read-only linked dealer (Edit) */}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Dealer</label>
        {initial ? (
          <div style={{ ...inp, display: "flex", alignItems: "center", background: "#fafafa", color: "#555" }}>
            {dealerName} <span className="font-mono" style={{ marginLeft: 8, fontSize: 11, color: "#999" }}>{dealerId}</span>
          </div>
        ) : dealerPicked ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid #1976d2", borderRadius: 6, background: "#e3f2fd" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "#0d47a1", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {resolving ? "Resolving…" : dealerName}
                {cdkFed && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: "#1976d2", color: "#fff" }}>CDK</span>}
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: "#1565c0" }}>{dealerId}</div>
            </div>
            <button type="button" onClick={clearDealer} style={{ background: "none", border: "none", color: "#1976d2", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>change</button>
          </div>
        ) : (
          <div style={{ position: "relative" }}>
            <input value={dealerQuery} onChange={e => setDealerQuery(e.target.value)} style={inp} placeholder="Search by dealer name or ID…" autoFocus />
            {dealerHits.length > 0 && (
              <div style={{ position: "absolute", top: 40, left: 0, right: 0, zIndex: 10, background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, maxHeight: 260, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                {dealerHits.map(h => (
                  <button key={h.id} type="button" onClick={() => void pickDealer(h)} style={{ display: "flex", width: "100%", alignItems: "center", gap: 8, padding: "8px 10px", border: "none", borderBottom: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#333", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span>
                    {/^3PA/i.test(h.dealer_id) && <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: "#e3f2fd", color: "#1976d2" }}>CDK</span>}
                    <span className="font-mono" style={{ fontSize: 11, color: "#999" }}>{h.dealer_id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {noMatch && !dealerPicked && !initial && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#78828c" }}>
            No dealer matches &lsquo;{dealerQuery.trim()}&rsquo; — clear and search by dealer name or ID.
          </div>
        )}
        {alreadyAdded && !initial && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#c62828" }}>This dealer already has a Fortellis connection — remove or edit that row instead.</div>
        )}
      </div>

      {/* Subscription */}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Subscription</label>
        {subs === null && !subsError ? (
          <div style={{ fontSize: 12, color: "#78828c" }}>Loading subscriptions…</div>
        ) : subsError ? (
          <div style={{ fontSize: 12, color: "#c62828", marginBottom: 6 }}>{subsError} — enter the Subscription-Id manually below.</div>
        ) : (
          <select
            style={inp}
            value={subscriptionId}
            onChange={e => {
              const id = e.target.value;
              setSubscriptionId(id);
              // Cross-fill: picking a subscription suggests its dealer in the search box.
              const s = subs?.find(x => x.subscriptionId === id);
              if (s?.orgName && !dealerPicked && !initial) setDealerQuery(s.orgName);
            }}
          >
            <option value="">— pick a subscription —</option>
            {subs?.map(s => (
              <option key={s.subscriptionId} value={s.subscriptionId}>
                {(s.orgName ?? s.subscriptionId)}{s.environment ? ` · ${s.environment}` : ""}{s.status ? ` · ${s.status}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Subscription-Id</label>
        <input value={subscriptionId} onChange={e => setSubscriptionId(e.target.value)} style={inp} placeholder="Fortellis Subscription-Id" />
      </div>

      {/* Optional scoping filters — autofilled, still editable */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={lbl}>webId (optional)</label>
          <input value={webId} onChange={e => setWebId(e.target.value)} style={inp} placeholder="motp-…-cdkinv" />
        </div>
        <div style={{ flex: 1 }}>
          <label style={lbl}>dealerCode {cdkFed ? "(from CDK)" : "(optional)"}</label>
          <input value={dealerCode} onChange={e => setDealerCode(e.target.value)} style={inp} placeholder="e.g. 5236a" />
        </div>
      </div>

      {initial && (
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Enabled (included in hourly delta)</label>
          <div style={{ display: "flex", gap: 8 }}>
            {[true, false].map(v => (
              <button key={String(v)} type="button" onClick={() => setEnabled(v)} style={{ padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", background: enabled === v ? (v ? "#e8f5e9" : "#fafafa") : "#fff", color: enabled === v ? (v ? "#2e7d32" : "#78828c") : "#78828c", border: `1px solid ${enabled === v ? (v ? "#4caf50" : "#c0c0c0") : "#e0e0e0"}` }}>{v ? "Enabled" : "Disabled"}</button>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving || resolving || (!initial && alreadyAdded)}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

// ── Delete modal ─────────────────────────────────────────────────────────────
function DeleteModal({ row, onClose, onConfirm }: { row: FortellisRow; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal title="Remove Fortellis Dealer" onClose={onClose}>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
        Remove <strong>{row.dealer_name}</strong> from Fortellis Dealers? Existing vehicles stay in inventory; this only stops future syncs.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button onClick={onConfirm} style={{ padding: "8px 16px", background: "#ff5252", color: "#fff", border: "1px solid #ff5252", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: "pointer" }}>Remove</button>
      </div>
    </Modal>
  );
}

// ── Generic modal wrapper ────────────────────────────────────────────────────
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, width: "min(520px, 96vw)", padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
