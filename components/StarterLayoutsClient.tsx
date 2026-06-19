"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface StarterRow {
  id: string;
  name: string;
  doc_type: "addendum" | "infosheet" | "buyers_guide";
  paper: string;
  sort_order: number;
  updated_at: string;
}

const DOC_LABELS: Record<string, string> = {
  addendum: "Addendum",
  infosheet: "Infosheet",
  buyers_guide: "Buyer's Guide",
};

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function StarterLayoutsClient() {
  const router = useRouter();
  const [rows, setRows] = useState<StarterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/starter-templates", { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error || `Failed to load (HTTP ${res.status})`);
        return;
      }
      const j = await res.json() as { data: StarterRow[] };
      setRows(j.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load starter layouts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/starter-templates/${deleteId}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error || `Delete failed (HTTP ${res.status})`);
        return;
      }
      setDeleteId(null);
      await refresh();
    } finally {
      setDeleting(false);
    }
  }

  const deleteTarget = rows.find(r => r.id === deleteId) ?? null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
        <button
          onClick={() => router.push("/starter-layouts/builder")}
          style={{ height: 38, padding: "0 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
        >
          + New Starter Layout
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16, padding: "10px 14px", background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div className="card" style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "#78828c", fontSize: 14 }}>
            No starter layouts yet. Click <strong>+ New Starter Layout</strong> to build one in the Builder.
          </div>
        ) : (
          <table style={{ width: "100%", fontSize: 14, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0", background: "#fafafa", textAlign: "left" }}>
                <th style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em" }}>Name</th>
                <th style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em" }}>Doc Type</th>
                <th style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em" }}>Updated</th>
                <th style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: i < rows.length - 1 ? "1px solid #f0f0f0" : "none" }}>
                  <td style={{ padding: "10px 16px", fontWeight: 500, color: "#2a2b3c" }}>{r.name}</td>
                  <td style={{ padding: "10px 16px", color: "#555" }}>{DOC_LABELS[r.doc_type] ?? r.doc_type}</td>
                  <td style={{ padding: "10px 16px", color: "#78828c", fontSize: 13 }}>{fmtDate(r.updated_at)}</td>
                  <td style={{ padding: "10px 16px", textAlign: "right" }}>
                    <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                      <button
                        onClick={() => router.push(`/starter-layouts/builder?id=${encodeURIComponent(r.id)}`)}
                        style={{ height: 30, padding: "0 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setDeleteId(r.id)}
                        style={{ height: 30, padding: "0 12px", background: "#fff", color: "#c62828", border: "1px solid #ffcdd2", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                      >
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {deleteTarget && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) setDeleteId(null); }}
        >
          <div style={{ background: "#fff", borderRadius: 6, width: 440, maxWidth: "92vw", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <div style={{ padding: "14px 18px", background: "#2a2b3c" }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Delete starter layout</span>
            </div>
            <div style={{ padding: 20 }}>
              <p style={{ fontSize: 14, color: "#333", margin: "0 0 16px", lineHeight: 1.6 }}>
                Delete <strong>{deleteTarget.name}</strong>? Dealers will no longer see it as a starting layout. This can&apos;t be undone.
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => setDeleteId(null)} disabled={deleting}
                  style={{ padding: "8px 14px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c" }}>
                  Cancel
                </button>
                <button onClick={() => void confirmDelete()} disabled={deleting}
                  style={{ padding: "8px 14px", background: deleting ? "#9aa4ad" : "#c62828", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: deleting ? "default" : "pointer" }}>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
