"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fmtDate } from "@/lib/crm/format";

export type CompanyFile = { id: string; filename: string; label: string | null; size: number | null; created_at: string; uploaded_by_name: string | null };

function fmtSize(n: number | null): string {
  if (!n) return "—";
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default function CompanyFilesPanel({ companyId, files }: { companyId: string; files: CompanyFile[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload() {
    const f = input.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", f);
    if (label.trim()) fd.append("label", label.trim());
    const res = await fetch(`/api/crm/companies/${companyId}/files`, { method: "POST", body: fd });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Upload failed"); return; }
    setLabel("");
    if (input.current) input.current.value = "";
    router.refresh();
  }

  async function remove(id: string, name: string) {
    if (!window.confirm(`Remove ${name}?`)) return;
    const res = await fetch(`/api/crm/files/${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  return (
    <div>
      <div style={{ padding: 16, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
        <div><label className="label">File</label><input ref={input} type="file" style={{ fontSize: 13 }} /></div>
        <div style={{ minWidth: 220 }}><label className="label">Label</label><input className="input" placeholder="e.g. Feed request PDF" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
        <button type="button" className="btn btn-primary" onClick={upload} disabled={busy}>{busy ? "Uploading…" : "Upload"}</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
      {!files.length ? (
        <p className="text-sm" style={{ color: "var(--text-muted)", padding: 16, margin: 0 }}>No files yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {files.map((f) => (
            <li key={f.id} style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 10, alignItems: "center" }}>
              <a href={`/api/crm/files/${f.id}`} style={{ color: "var(--blue)", fontWeight: 500 }}>{f.filename}</a>
              {f.label && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{f.label}</span>}
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                {fmtSize(f.size)} · {fmtDate(f.created_at)}{f.uploaded_by_name ? ` · ${f.uploaded_by_name}` : ""}
              </span>
              <button type="button" onClick={() => remove(f.id, f.filename)} style={{ background: "none", border: "none", color: "var(--error)", cursor: "pointer", fontSize: 12 }}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
