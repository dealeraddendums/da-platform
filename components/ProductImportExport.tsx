"use client";

import { useRef, useState } from "react";

// Export / Import buttons + the import preview modal, shared by the dealer
// Products page (OptionsLibrary) and the group Corporate Products tab
// (GroupOptionsPanel). Flow: pick file → server parses+validates (PREVIEW,
// nothing written) → user reviews "{N} updates · {N} new · {N} unchanged ·
// {N} errors" with per-row messages → "Apply valid rows" re-sends the parsed
// rows for a server-side re-validated APPLY. Cancel writes nothing; imports
// can never delete. Same-name rows are legitimate product VARIATIONS — the
// preview deliberately never warns about duplicate names.

type PlanRow = {
  rowNum: number;
  action: "update" | "create" | "unchanged" | "error";
  name: string;
  productId: string | null;
  changedFields: string[];
  errors: string[];
};
type ParsedRow = { rowNum: number; values: Record<string, string> };

export default function ProductImportExport({ endpoint, onImported }: {
  /** Sheet endpoint base, e.g. /api/addendum-library/sheet?dealer_id=X or /api/group-options/{id}/sheet */
  endpoint: string;
  onImported: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ plan: PlanRow[]; parsedRows: ParsedRow[] } | null>(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setBusy(true);
    setToast(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(endpoint, { method: "POST", body: fd });
      const j = await res.json() as { plan?: PlanRow[]; parsedRows?: ParsedRow[]; error?: string };
      if (!res.ok || !j.plan) { setToast(j.error ?? `Preview failed (${res.status})`); return; }
      setPreview({ plan: j.plan, parsedRows: j.parsedRows ?? [] });
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;
    setApplying(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview.parsedRows }),
      });
      const j = await res.json() as { ok?: boolean; results?: { updated: number; created: number; unchanged: number; failed: number; errors: string[] }; error?: string };
      if (!res.ok || !j.results) { setToast(j.error ?? `Import failed (${res.status})`); return; }
      const r = j.results;
      setToast(`Imported — ${r.updated} updated, ${r.created} created${r.failed ? `, ${r.failed} rows skipped/failed` : ""}.`);
      setPreview(null);
      onImported();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Import failed");
    } finally {
      setApplying(false);
    }
  }

  const counts = preview ? {
    update: preview.plan.filter((p) => p.action === "update").length,
    create: preview.plan.filter((p) => p.action === "create").length,
    unchanged: preview.plan.filter((p) => p.action === "unchanged").length,
    error: preview.plan.filter((p) => p.action === "error").length,
  } : null;

  const btn: React.CSSProperties = {
    padding: "7px 14px", background: "#fff", color: "#55595c",
    border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13, fontFamily: "inherit",
  };

  return (
    <>
      <div style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
        <a href={endpoint} download style={{ ...btn, textDecoration: "none", display: "inline-block" }}>
          ⬇ Export (.xlsx)
        </a>
        <button type="button" style={btn} disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "Reading…" : "⬆ Import"}
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.csv" style={{ display: "none" }} onChange={(e) => void handleFile(e)} />
        {toast && <span style={{ fontSize: 12, color: toast.startsWith("Imported") ? "#2e7d32" : "#c62828" }}>{toast}</span>}
      </div>

      {preview && counts && (
        <div onClick={(e) => { if (e.target === e.currentTarget) setPreview(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 24, overflowY: "auto" }}>
          <div style={{ background: "#fff", borderRadius: 8, width: 720, maxWidth: "100%", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #e0e0e0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 15, color: "#2a2b3c" }}>Import preview — nothing has been changed yet</strong>
              <button type="button" onClick={() => setPreview(null)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#78828c" }}>×</button>
            </div>
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #f0f0f0", display: "flex", gap: 14, fontSize: 13, flexWrap: "wrap" }}>
              <span style={{ color: "#1565c0", fontWeight: 700 }}>{counts.update} update{counts.update === 1 ? "" : "s"}</span>
              <span style={{ color: "#2e7d32", fontWeight: 700 }}>{counts.create} new</span>
              <span style={{ color: "#78828c" }}>{counts.unchanged} unchanged</span>
              <span style={{ color: counts.error ? "#c62828" : "#78828c", fontWeight: counts.error ? 700 : 400 }}>{counts.error} error{counts.error === 1 ? "" : "s"}</span>
            </div>
            <div style={{ overflowY: "auto", padding: "8px 20px", flex: 1 }}>
              {preview.plan.filter((p) => p.action !== "unchanged").map((p) => (
                <div key={p.rowNum} style={{ padding: "7px 0", borderBottom: "1px solid #f5f5f5", fontSize: 13 }}>
                  <span style={{ color: "#9aa0a6", fontFamily: "monospace", marginRight: 8 }}>row {p.rowNum}</span>
                  <span style={{
                    fontWeight: 700, marginRight: 8,
                    color: p.action === "error" ? "#c62828" : p.action === "create" ? "#2e7d32" : "#1565c0",
                  }}>{p.action === "create" ? "NEW" : p.action.toUpperCase()}</span>
                  <span style={{ color: "#333" }} dangerouslySetInnerHTML={{ __html: p.name }} />
                  {p.action === "update" && p.changedFields.length > 0 && (
                    <span style={{ color: "#78828c", fontSize: 12 }}> — {p.changedFields.join(", ")}</span>
                  )}
                  {p.errors.map((e, i) => (
                    <div key={i} style={{ color: "#c62828", fontSize: 12, marginLeft: 60 }}>{e}</div>
                  ))}
                </div>
              ))}
              {preview.plan.every((p) => p.action === "unchanged") && (
                <p style={{ color: "#78828c", fontSize: 13 }}>Every row matches the current data — nothing to apply.</p>
              )}
            </div>
            <div style={{ padding: "12px 20px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => setPreview(null)} style={btn}>Cancel — change nothing</button>
              <button type="button" disabled={applying || (counts.update + counts.create === 0)} onClick={() => void apply()}
                style={{ ...btn, background: "#1976d2", color: "#fff", border: "none", fontWeight: 600, opacity: (counts.update + counts.create === 0) ? 0.5 : 1 }}>
                {applying ? "Applying…" : counts.error > 0 ? `Apply ${counts.update + counts.create} valid row${counts.update + counts.create === 1 ? "" : "s"}` : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
