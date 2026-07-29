"use client";

import { useState, useEffect, useCallback } from "react";
import { PageHeader } from "@/components/PageHeader";

export const dynamic = "force-dynamic";

interface TekionRow {
  id: number;
  dealer_id: string | null;
  dealer_name: string | null;
  last_update?: string | null;
}

interface TestResult {
  dealer_id: string;
  verdict: "green" | "amber" | "red";
  feed_file: {
    checked: boolean;
    error?: string;
    exists: boolean;
    filename: string;
    size_bytes?: number;
    modified_at?: string | null;
    age_hours?: number | null;
    fresh?: boolean;
  };
  inventory: {
    checked: boolean;
    error?: string;
    dealer_matched: boolean;
    dealer_name?: string;
    da_dealer_id?: string;
    active_count?: number;
    last_updated_at?: string | null;
    last_added_at?: string | null;
    added_last_7d?: number;
  };
  tested_at: string;
}

type FormState = { dealer_name: string; dealer_id: string };
const BLANK_FORM: FormState = { dealer_name: "", dealer_id: "" };

const inp: React.CSSProperties = { width: "100%", padding: "8px 10px", height: 36, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", fontSize: 13, color: "#333" };
const lbl: React.CSSProperties = { display: "block", fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 };

export default function TekionDealersPage() {
  const [rows, setRows] = useState<TekionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editRow, setEditRow] = useState<TekionRow | "new" | null>(null);
  const [deleteRow, setDeleteRow] = useState<TekionRow | null>(null);
  const [search, setSearch] = useState("");
  const [testRow, setTestRow] = useState<TekionRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/tekion-dealers");
    if (res.ok) {
      const j = await res.json() as { data: TekionRow[] };
      setRows(j.data);
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = rows.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (r.dealer_name ?? "").toLowerCase().includes(q)
      || (r.dealer_id ?? "").toLowerCase().includes(q);
  });

  return (
    <div>
      <PageHeader
        title="Tekion Dealers"
        subtitle={`${rows.length} dealer${rows.length === 1 ? "" : "s"} configured for Tekion`}
        action={
          <button className="btn btn-primary" onClick={() => setEditRow("new")}>+ Add Dealer</button>
        }
      />

      <div className="card p-4 mb-4">
        <input
          type="text"
          className="input w-full"
          placeholder="Search by name or dealer ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            {rows.length === 0 ? "No Tekion dealers configured yet." : "No dealers match your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                {["Dealer Name", "Dealer ID", "Actions"].map(h => (
                  <th key={h} className="px-4 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < filtered.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td className="px-4 py-2.5"><span style={{ color: "var(--text-primary)" }}>{r.dealer_name ?? "—"}</span></td>
                  <td className="px-4 py-2.5"><span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{r.dealer_id ?? "—"}</span></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setTestRow(r)}>Test</button>
                      <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setEditRow(r)}>Edit</button>
                      <button className="text-xs" style={{ color: "var(--error)", background: "none", border: "none", cursor: "pointer", padding: 0 }} onClick={() => setDeleteRow(r)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
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

      {testRow && (
        <TestModal row={testRow} onClose={() => setTestRow(null)} />
      )}
    </div>
  );
}

function EditModal({ initial, onClose, onSaved }: { initial: TekionRow | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<FormState>(() =>
    initial ? { dealer_name: initial.dealer_name ?? "", dealer_id: initial.dealer_id ?? "" } : BLANK_FORM
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!form.dealer_name.trim() || !form.dealer_id.trim()) {
      setError("Dealer Name and Dealer ID are both required");
      return;
    }
    setSaving(true);
    const url = initial ? `/api/admin/tekion-dealers/${initial.id}` : "/api/admin/tekion-dealers";
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
    <Modal title={initial ? "Edit Tekion Dealer" : "Add Tekion Dealer"} onClose={onClose}>
      {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Dealer Name</label>
        <input value={form.dealer_name} onChange={e => setForm({ ...form, dealer_name: e.target.value })} style={inp} placeholder="e.g. Toyota Carlsbad" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <label style={lbl}>Dealer ID</label>
        <input value={form.dealer_id} onChange={e => setForm({ ...form, dealer_id: e.target.value })} style={inp} placeholder="e.g. 8917037" />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </Modal>
  );
}

function DeleteModal({ row, onClose, onDeleted }: { row: TekionRow; onClose: () => void; onDeleted: () => void }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setDeleting(true);
    const res = await fetch(`/api/admin/tekion-dealers/${row.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? "Delete failed");
      return;
    }
    onDeleted();
  }
  return (
    <Modal title="Delete Tekion Dealer" onClose={onClose}>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.6 }}>
        Delete <strong>{row.dealer_name}</strong>? This cannot be undone.
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

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  green: { bg: "#e8f5e9", fg: "#2e7d32", label: "Feed healthy" },
  amber: { bg: "#fff8e1", fg: "#b26a00", label: "Feed file stale" },
  red:   { bg: "#ffebee", fg: "#c62828", label: "No feed file — Tekion not delivering" },
};

function TestModal({ row, onClose }: { row: TekionRow; onClose: () => void }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/tekion-dealers/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealer_id: row.dealer_id }),
        });
        const j = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError((j as { error?: string }).error ?? "Test failed"); return; }
        setResult(j as TestResult);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [row.dealer_id]);

  const rowStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13, borderBottom: "1px solid #f0f0f0" };
  const kStyle: React.CSSProperties = { color: "#78828c" };
  const vStyle: React.CSSProperties = { color: "#333", fontWeight: 500, textAlign: "right" };
  const secStyle: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", margin: "16px 0 4px" };

  const ff = result?.feed_file;
  const inv = result?.inventory;
  const verdict = result ? VERDICT_STYLE[result.verdict] : null;

  return (
    <Modal title={`Test Feed — ${row.dealer_name ?? row.dealer_id}`} onClose={onClose}>
      {!result && !error && (
        <div style={{ padding: "24px 0", textAlign: "center", color: "#78828c", fontSize: 13 }}>
          Checking FTP + inventory…
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>
      )}
      {result && verdict && (
        <>
          <div style={{ padding: "10px 14px", background: verdict.bg, color: verdict.fg, borderRadius: 6, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            {verdict.label}
          </div>

          <div style={secStyle}>Feed file (FTP · tekion23ftp)</div>
          {ff?.error ? (
            <div style={{ fontSize: 12, color: "#c62828" }}>FTP check failed: {ff.error}</div>
          ) : (
            <>
              <div style={rowStyle}><span style={kStyle}>Expected file</span><span style={{ ...vStyle, fontFamily: "monospace", fontSize: 12 }}>{ff?.filename}</span></div>
              <div style={rowStyle}><span style={kStyle}>Present</span><span style={{ ...vStyle, color: ff?.exists ? "#2e7d32" : "#c62828" }}>{ff?.exists ? "Yes" : "No — nothing delivered"}</span></div>
              {ff?.exists && (
                <>
                  <div style={rowStyle}><span style={kStyle}>Last modified</span><span style={vStyle}>{fmtWhen(ff.modified_at)}{ff.age_hours != null ? ` (${ff.age_hours} h ago)` : ""}</span></div>
                  <div style={rowStyle}><span style={kStyle}>Size</span><span style={vStyle}>{fmtSize(ff.size_bytes)}</span></div>
                </>
              )}
            </>
          )}

          <div style={secStyle}>Platform inventory</div>
          {inv?.error ? (
            <div style={{ fontSize: 12, color: "#c62828" }}>Inventory check failed: {inv.error}</div>
          ) : !inv?.dealer_matched ? (
            <div style={{ fontSize: 12, color: "#b26a00" }}>
              No dealer record matches this Tekion ID (checked inventory_dealer_id and dealer_id) — inventory can’t be verified.
            </div>
          ) : (
            <>
              <div style={rowStyle}><span style={kStyle}>Dealer</span><span style={vStyle}>{inv.dealer_name ?? "—"} ({inv.da_dealer_id})</span></div>
              <div style={rowStyle}><span style={kStyle}>Active vehicles</span><span style={vStyle}>{inv.active_count ?? 0}</span></div>
              <div style={rowStyle}><span style={kStyle}>Last inventory update</span><span style={vStyle}>{fmtWhen(inv.last_updated_at)}</span></div>
              <div style={rowStyle}><span style={kStyle}>Newest vehicle added</span><span style={vStyle}>{fmtWhen(inv.last_added_at)}</span></div>
              <div style={rowStyle}><span style={kStyle}>Added in last 7 days</span><span style={vStyle}>{inv.added_last_7d ?? 0}</span></div>
            </>
          )}

          <div style={{ fontSize: 11, color: "#9aa4ae", marginTop: 12 }}>
            Tekion delivers {"{dealer id}"}.csv hourly to the tekion23ftp FTP account; ETL2 job 40 imports at :25 past each hour.
          </div>
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

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
