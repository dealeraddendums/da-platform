"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

interface CdkRow {
  id: number;
  DEALER_ID: string | null;
  ICOMPANY: string | null;
  DEALER_NAME: string | null;
  NEW: string | null;
  LAST_DELTA?: string | null;
}

type FormState = {
  DEALER_NAME: string;
  DEALER_ID: string;
  ICOMPANY: string;
  NEW: "Yes" | "No";
};
const BLANK_FORM: FormState = { DEALER_NAME: "", DEALER_ID: "", ICOMPANY: "", NEW: "No" };

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", height: 36, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 13, color: "#333" };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 };

interface CdkBulkStatus {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at?: string | null;
  delta_date: string;
  total_dealers: number;
  completed: number;
  failed: number;
  current_dealer?: string | null;
  total_vehicles_imported: number;
  total_vehicles_skipped: number;
  errors: Array<{ dealer_id: string; dealer_name: string; error: string }>;
}

export default function CdkDealersPage() {
  const [rows, setRows] = useState<CdkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editRow, setEditRow] = useState<CdkRow | "new" | null>(null);
  const [deleteRow, setDeleteRow] = useState<CdkRow | null>(null);
  const [importRow, setImportRow] = useState<CdkRow | null>(null);
  const [testResult, setTestResult] = useState<Record<number, { ok: boolean; msg: string } | null>>({});
  const [testing, setTesting] = useState<Record<number, boolean>>({});
  const [search, setSearch] = useState("");
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkStatus, setBulkStatus] = useState<CdkBulkStatus | null>(null);
  const [bulkStalled, setBulkStalled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/cdk-dealers");
    if (res.ok) {
      const j = await res.json() as { data: CdkRow[] };
      setRows(j.data);
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Self-chaining poll on the bulk job status. The previous useEffect-based
  // approach stopped polling whenever `completed` didn't change between two
  // ticks (common during slow CDK calls — a single dealer can take 30s),
  // so the bar froze. This version chains the next setTimeout from inside
  // tick itself, decoupling it from React's render cycle.
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCancelledRef = useRef(false);

  const pollBulkStatus = useCallback(async () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    try {
      const res = await fetch("/api/admin/cdk/bulk-update/status", { cache: "no-store" });
      if (pollCancelledRef.current) return;
      if (!res.ok) {
        pollTimerRef.current = setTimeout(() => { void pollBulkStatus(); }, 3000);
        return;
      }
      const j = await res.json() as { status: CdkBulkStatus | null; stalled?: boolean };
      if (pollCancelledRef.current) return;
      setBulkStatus(j.status);
      setBulkStalled(Boolean(j.stalled));
      if (j.status?.status === "running" && !j.stalled) {
        pollTimerRef.current = setTimeout(() => { void pollBulkStatus(); }, 1500);
      }
    } catch {
      if (!pollCancelledRef.current) {
        pollTimerRef.current = setTimeout(() => { void pollBulkStatus(); }, 3000);
      }
    }
  }, []);

  useEffect(() => {
    pollCancelledRef.current = false;
    void pollBulkStatus();
    return () => {
      pollCancelledRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [pollBulkStatus]);

  async function dismissBulkStatus() {
    await fetch("/api/admin/cdk/bulk-update/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss" }),
    });
    setBulkStatus(null);
    setBulkStalled(false);
  }

  async function runTest(r: CdkRow) {
    if (!r.DEALER_ID || !r.ICOMPANY) return;
    setTesting(prev => ({ ...prev, [r.id]: true }));
    setTestResult(prev => ({ ...prev, [r.id]: null }));
    try {
      const res = await fetch("/api/admin/cdk/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: r.DEALER_ID, icompany: r.ICOMPANY }),
      });
      const j = await res.json() as { success?: boolean; count?: number; error?: string };
      if (j.success) {
        setTestResult(prev => ({ ...prev, [r.id]: { ok: true, msg: `Connection successful — ${j.count ?? 0} vehicles found` } }));
      } else {
        setTestResult(prev => ({ ...prev, [r.id]: { ok: false, msg: `Connection failed — ${j.error ?? "unknown error"}` } }));
      }
    } finally {
      setTesting(prev => ({ ...prev, [r.id]: false }));
    }
  }

  // Default sort: NEW='Yes' first, then alphabetical by DEALER_NAME within
  // each group. Search filter applied on top.
  const filtered = rows
    .filter(r => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (r.DEALER_NAME ?? "").toLowerCase().includes(q)
        || (r.DEALER_ID ?? "").toLowerCase().includes(q)
        || (r.ICOMPANY ?? "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const aNew = (a.NEW ?? "").toLowerCase() === "yes" ? 0 : 1;
      const bNew = (b.NEW ?? "").toLowerCase() === "yes" ? 0 : 1;
      if (aNew !== bNew) return aNew - bNew;
      return (a.DEALER_NAME ?? "").localeCompare(b.DEALER_NAME ?? "");
    });

  return (
    <div>
      <PageHeader
        title="CDK Dealers"
        subtitle={`${rows.length} dealer${rows.length === 1 ? "" : "s"} configured for CDK extracts`}
        action={
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setBulkModalOpen(true)}
              disabled={bulkStatus?.status === "running" && !bulkStalled}
              style={{
                padding: "8px 16px",
                background: "#ffa500",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 600,
                cursor: bulkStatus?.status === "running" && !bulkStalled ? "not-allowed" : "pointer",
                opacity: bulkStatus?.status === "running" && !bulkStalled ? 0.6 : 1,
                fontFamily: "inherit",
              }}
            >
              CDK Update
            </button>
            <button className="btn btn-primary" onClick={() => setEditRow("new")}>+ Add Dealer</button>
          </div>
        }
      />

      {bulkStatus && (
        <BulkStatusBanner status={bulkStatus} stalled={bulkStalled} onDismiss={() => void dismissBulkStatus()} />
      )}

      <div className="card p-4 mb-4">
        <input
          type="text"
          className="input w-full"
          placeholder="Search by name, dealer ID, or icompany…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            {rows.length === 0 ? "No CDK dealers configured yet." : "No dealers match your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Dealer Name", "Dealer ID", "iCompany", "New", "Actions"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const isNew = (r.NEW ?? "").toLowerCase() === "yes";
                const tr = testResult[r.id];
                return (
                  <>
                    <tr key={r.id} style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
                      <td className="px-4 py-2.5"><span style={{ color: "var(--text-primary)" }}>{r.DEALER_NAME ?? "—"}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{r.DEALER_ID ?? "—"}</span></td>
                      <td className="px-4 py-2.5"><span style={{ color: "var(--text-secondary)" }}>{r.ICOMPANY ?? "—"}</span></td>
                      <td className="px-4 py-2.5">
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                          background: isNew ? "#e8f5e9" : "#fafafa",
                          color: isNew ? "#2e7d32" : "#78828c",
                          border: `1px solid ${isNew ? "#c8e6c9" : "#e0e0e0"}`,
                        }}>
                          {isNew ? "Yes" : "No"}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          {isNew && (
                            <>
                              <button
                                onClick={() => void runTest(r)}
                                disabled={testing[r.id]}
                                style={{ fontSize: 11, padding: "4px 10px", border: "1px solid #1976d2", color: "#1976d2", background: "#fff", borderRadius: 4, cursor: testing[r.id] ? "wait" : "pointer", fontFamily: "inherit" }}
                              >
                                {testing[r.id] ? "Testing…" : "Test"}
                              </button>
                              <button
                                onClick={() => setImportRow(r)}
                                style={{ fontSize: 11, padding: "4px 10px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                              >
                                Import
                              </button>
                            </>
                          )}
                          <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setEditRow(r)}>Edit</button>
                          <button className="text-xs" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setDeleteRow(r)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                    {tr && (
                      <tr style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <td colSpan={5} className="px-4 py-2 text-xs" style={{ background: tr.ok ? "#e8f5e9" : "#ffebee", color: tr.ok ? "#2e7d32" : "#c62828" }}>
                          {tr.ok ? "✓" : "✕"} {tr.msg}
                          <button onClick={() => setTestResult(prev => ({ ...prev, [r.id]: null }))} style={{ background: "none", border: "none", color: "inherit", marginLeft: 12, cursor: "pointer", fontSize: 12, opacity: 0.6 }}>dismiss</button>
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
        <EditModal
          initial={editRow === "new" ? null : editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); void load(); }}
        />
      )}

      {deleteRow && (
        <DeleteModal
          row={deleteRow}
          onClose={() => setDeleteRow(null)}
          onDeleted={() => { setDeleteRow(null); void load(); }}
        />
      )}

      {importRow && (
        <ImportModal
          row={importRow}
          onClose={() => setImportRow(null)}
          onImported={() => {
            // The server flips NEW='No' on success — mirror that locally so
            // the Test + Import buttons disappear without a refetch. The
            // user can still close the modal at their own pace.
            setRows(prev => prev.map(r => r.id === importRow.id ? { ...r, NEW: "No" } : r));
          }}
        />
      )}

      {bulkModalOpen && (
        <BulkUpdateModal
          onClose={() => setBulkModalOpen(false)}
          onStarted={(initial) => {
            setBulkStatus(initial);
            setBulkStalled(false);
            setBulkModalOpen(false);
            // Kick polling back to life — on mount it stopped after seeing
            // status=null, and the self-chaining loop won't restart on its
            // own when state goes running.
            void pollBulkStatus();
          }}
        />
      )}
    </div>
  );
}

// ── Bulk progress banner ─────────────────────────────────────────────────────

function BulkStatusBanner({ status, stalled, onDismiss }: { status: CdkBulkStatus; stalled: boolean; onDismiss: () => void }) {
  const running = status.status === "running" && !stalled;
  const failedAll = status.status === "failed";
  const done = status.status === "completed" || stalled;

  if (running) {
    const pct = status.total_dealers > 0 ? Math.round((status.completed / status.total_dealers) * 100) : 0;
    return (
      <div className="card p-4 mb-4" style={{ background: "#fff8e1", border: "1px solid #ffe082" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#7a5c00" }}>
            CDK Update in progress — {status.completed} of {status.total_dealers} dealers
            {status.current_dealer ? ` — ${status.current_dealer}…` : "…"}
          </div>
          <div style={{ fontSize: 12, color: "#7a5c00" }}>{pct}%</div>
        </div>
        <div style={{ height: 6, background: "#fff", borderRadius: 3, overflow: "hidden", border: "1px solid #ffe082" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "#ffa500", transition: "width 0.3s ease" }} />
        </div>
        {status.failed > 0 && (
          <div style={{ fontSize: 11, color: "#c62828", marginTop: 6 }}>
            {status.failed} dealer{status.failed === 1 ? "" : "s"} failed so far
          </div>
        )}
      </div>
    );
  }

  const succeeded = status.total_dealers - status.failed;
  const tone = failedAll ? "#ffebee" : stalled ? "#fff8e1" : "#e8f5e9";
  const border = failedAll ? "#ffcdd2" : stalled ? "#ffe082" : "#c8e6c9";
  const color = failedAll ? "#c62828" : stalled ? "#7a5c00" : "#2e7d32";

  return (
    <div className="card p-4 mb-4" style={{ background: tone, border: `1px solid ${border}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 13, color, lineHeight: 1.7 }}>
          {stalled ? (
            <strong>CDK Update stalled — last activity over 30 minutes ago. The worker may have restarted mid-run.</strong>
          ) : failedAll ? (
            <strong>CDK Update failed</strong>
          ) : (
            <strong>CDK Update complete — {status.total_vehicles_imported.toLocaleString()} vehicles imported across {succeeded} dealer{succeeded === 1 ? "" : "s"}{status.failed > 0 ? `. ${status.failed} failed.` : "."}</strong>
          )}
          {done && !stalled && (
            <div style={{ fontSize: 12, marginTop: 4, color }}>
              {status.total_vehicles_skipped.toLocaleString()} skipped (already in inventory)
            </div>
          )}
          {status.errors.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
                Errors ({status.errors.length}):
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color }}>
                {status.errors.slice(0, 25).map((e, i) => (
                  <li key={i}>
                    <strong>{e.dealer_name || e.dealer_id}</strong> — {e.error}
                  </li>
                ))}
                {status.errors.length > 25 && (
                  <li style={{ listStyle: "none", fontStyle: "italic" }}>
                    …and {status.errors.length - 25} more.
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
        <button
          onClick={onDismiss}
          style={{ background: "none", border: "none", color, cursor: "pointer", fontSize: 12, textDecoration: "underline", padding: 0, whiteSpace: "nowrap" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ── Bulk update modal ────────────────────────────────────────────────────────

function BulkUpdateModal({ onClose, onStarted }: { onClose: () => void; onStarted: (initial: CdkBulkStatus) => void }) {
  const [window, setWindow] = useState<"2" | "7" | "30" | "90" | "custom">("90");
  const [fromDate, setFromDate] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function computeDeltaDate(): string {
    if (window === "custom" && fromDate) {
      return `${fromDate}T00:00:00-0600`;
    }
    const days = parseInt(window, 10) || 90;
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00-0600`;
  }

  async function runUpdate() {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/admin/cdk/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta_date: computeDeltaDate() }),
      });
      const j = await res.json() as { ok?: boolean; total_dealers?: number; started_at?: string; error?: string };
      if (!res.ok || !j.ok) {
        setError(j.error ?? `Request failed (${res.status})`);
        return;
      }
      onStarted({
        status: "running",
        started_at: j.started_at ?? new Date().toISOString(),
        delta_date: computeDeltaDate(),
        total_dealers: j.total_dealers ?? 0,
        completed: 0,
        failed: 0,
        current_dealer: null,
        total_vehicles_imported: 0,
        total_vehicles_skipped: 0,
        errors: [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Modal title="CDK Bulk Update — All Dealers" onClose={onClose}>
      <label style={lbl}>Select Time Window</label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        {([
          { v: "2" as const, label: "Last 2 days" },
          { v: "7" as const, label: "Last 7 days" },
          { v: "30" as const, label: "Last 30 days" },
          { v: "90" as const, label: "Last 90 days" },
        ]).map(opt => (
          <button
            key={opt.v}
            type="button"
            onClick={() => setWindow(opt.v)}
            style={{
              padding: "8px 12px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: window === opt.v ? "#fff3e0" : "#fff",
              color: window === opt.v ? "#e65100" : "#78828c",
              border: `1px solid ${window === opt.v ? "#ffa500" : "#e0e0e0"}`,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setWindow("custom")}
        style={{
          width: "100%", padding: "8px 12px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
          background: window === "custom" ? "#fff3e0" : "#fff",
          color: window === "custom" ? "#e65100" : "#78828c",
          border: `1px solid ${window === "custom" ? "#ffa500" : "#e0e0e0"}`,
          marginBottom: 12,
        }}
      >
        Custom date range
      </button>
      {window === "custom" && (
        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>From</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inp} />
        </div>
      )}
      <div style={{ fontSize: 11, color: "#78828c", lineHeight: 1.5, marginBottom: 12, padding: "8px 10px", background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 4 }}>
        Runs sequentially across every CDK dealer (skipping test/allan accounts).
        Existing vehicles are never overwritten. This job may take several minutes.
      </div>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={starting}>Cancel</button>
        <button
          onClick={() => void runUpdate()}
          disabled={starting || (window === "custom" && !fromDate)}
          style={{
            padding: "8px 16px",
            background: "#ffa500",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            fontSize: 14,
            fontWeight: 600,
            cursor: starting ? "wait" : "pointer",
            opacity: starting || (window === "custom" && !fromDate) ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          {starting ? "Starting…" : "Run Update"}
        </button>
      </div>
    </Modal>
  );
}

// ── Edit / Add modal ─────────────────────────────────────────────────────────

function EditModal({ initial, onClose, onSaved }: { initial: CdkRow | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>(() =>
    initial
      ? { DEALER_NAME: initial.DEALER_NAME ?? "", DEALER_ID: initial.DEALER_ID ?? "", ICOMPANY: initial.ICOMPANY ?? "", NEW: (initial.NEW ?? "").toLowerCase() === "yes" ? "Yes" : "No" }
      : BLANK_FORM
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!form.DEALER_NAME.trim() || !form.DEALER_ID.trim() || !form.ICOMPANY.trim()) {
      setError("Dealer Name, Dealer ID, and iCompany are all required");
      return;
    }
    setSaving(true);
    const url = initial ? `/api/admin/cdk-dealers/${initial.id}` : "/api/admin/cdk-dealers";
    const method = initial ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <Modal title={initial ? "Edit CDK Dealer" : "Add CDK Dealer"} onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Dealer Name</label>
        <input value={form.DEALER_NAME} onChange={e => setForm({ ...form, DEALER_NAME: e.target.value })} style={inp} placeholder="e.g. Sun Toyota" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Dealer ID</label>
        <input value={form.DEALER_ID} onChange={e => setForm({ ...form, DEALER_ID: e.target.value })} style={inp} placeholder="e.g. 3PA41921" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>iCompany</label>
        <input value={form.ICOMPANY} onChange={e => setForm({ ...form, ICOMPANY: e.target.value })} style={inp} placeholder="e.g. 2" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>New</label>
        <div style={{ display: "flex", gap: 8 }}>
          {(["Yes", "No"] as const).map(v => (
            <button
              key={v}
              type="button"
              onClick={() => setForm({ ...form, NEW: v })}
              style={{
                padding: "6px 14px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
                background: form.NEW === v ? (v === "Yes" ? "#e8f5e9" : "#fafafa") : "#fff",
                color: form.NEW === v ? (v === "Yes" ? "#2e7d32" : "#78828c") : "#78828c",
                border: `1px solid ${form.NEW === v ? (v === "Yes" ? "#4caf50" : "#c0c0c0") : "#e0e0e0"}`,
              }}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

// ── Delete modal ─────────────────────────────────────────────────────────────

function DeleteModal({ row, onClose, onDeleted }: { row: CdkRow; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setDeleting(true);
    const res = await fetch(`/api/admin/cdk-dealers/${row.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? "Delete failed");
      return;
    }
    onDeleted();
  }
  return (
    <Modal title="Delete CDK Dealer" onClose={onClose}>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
        Delete <strong>{row.DEALER_NAME}</strong>? This cannot be undone.
      </p>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={deleting}>Cancel</button>
        <button
          onClick={() => void confirm()}
          disabled={deleting}
          style={{ padding: "8px 16px", background: "#ff5252", color: "#fff", border: "1px solid #ff5252", borderRadius: 4, fontSize: 14, fontWeight: 500, cursor: deleting ? "not-allowed" : "pointer" }}
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}

// ── Import modal ─────────────────────────────────────────────────────────────

function ImportModal({ row, onClose, onImported }: { row: CdkRow; onClose: () => void; onImported?: () => void }) {
  const [window, setWindow] = useState<"2" | "7" | "30" | "90" | "custom">("90");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ found: number; imported: number; skipped: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function computeDeltaDate(): string {
    if (window === "custom" && fromDate) {
      // Custom from-date as a 00:00 cutoff. End-date is informational; CDK
      // returns everything after deltaDate.
      return `${fromDate}T00:00:00-0600`;
    }
    const days = parseInt(window, 10) || 90;
    const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00-0600`;
  }

  async function runImport() {
    setError(null);
    setResult(null);
    setImporting(true);
    try {
      const res = await fetch("/api/admin/cdk/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealer_id: row.DEALER_ID,
          icompany: row.ICOMPANY,
          delta_date: computeDeltaDate(),
        }),
      });
      const j = await res.json() as { success?: boolean; vehicles_found?: number; vehicles_imported?: number; vehicles_skipped?: number; error?: string };
      if (!j.success) {
        setError(j.error ?? `Request failed (${res.status})`);
        return;
      }
      setResult({
        found: j.vehicles_found ?? 0,
        imported: j.vehicles_imported ?? 0,
        skipped: j.vehicles_skipped ?? 0,
      });
      onImported?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal title={`Import CDK Inventory — ${row.DEALER_NAME ?? ""}`} onClose={onClose}>
      {!result && (
        <>
          <label style={lbl}>Select Time Window</label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            {([
              { v: "2" as const, label: "Last 2 days" },
              { v: "7" as const, label: "Last 7 days" },
              { v: "30" as const, label: "Last 30 days" },
              { v: "90" as const, label: "Last 90 days" },
            ]).map(opt => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setWindow(opt.v)}
                style={{
                  padding: "8px 12px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  background: window === opt.v ? "#e3f2fd" : "#fff",
                  color: window === opt.v ? "#1565c0" : "#78828c",
                  border: `1px solid ${window === opt.v ? "#1976d2" : "#e0e0e0"}`,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setWindow("custom")}
            style={{
              width: "100%", padding: "8px 12px", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: window === "custom" ? "#e3f2fd" : "#fff",
              color: window === "custom" ? "#1565c0" : "#78828c",
              border: `1px solid ${window === "custom" ? "#1976d2" : "#e0e0e0"}`,
              marginBottom: 12,
            }}
          >
            Custom date range
          </button>
          {window === "custom" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={lbl}>From</label>
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={lbl}>To</label>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={inp} />
              </div>
            </div>
          )}
          {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={importing}>Cancel</button>
            <button
              onClick={() => void runImport()}
              disabled={importing || (window === "custom" && !fromDate)}
              style={{ padding: "8px 16px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 600, cursor: importing ? "wait" : "pointer", opacity: importing || (window === "custom" && !fromDate) ? 0.5 : 1 }}
            >
              {importing ? "Importing…" : "Import"}
            </button>
          </div>
        </>
      )}
      {result && (
        <>
          <div style={{ padding: 16, background: "#e8f5e9", border: "1px solid #c8e6c9", borderRadius: 4, color: "#2e7d32", fontSize: 14, lineHeight: 1.7 }}>
            <strong>Import complete</strong><br />
            <strong>{result.imported}</strong> vehicles imported<br />
            <strong>{result.skipped}</strong> already existed / skipped<br />
            <strong>{result.found}</strong> total returned from CDK
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── Generic modal wrapper ────────────────────────────────────────────────────

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
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
