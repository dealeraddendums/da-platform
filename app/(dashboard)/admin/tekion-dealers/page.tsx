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
