"use client";

// Pick an email template and render it for this company / contact as the
// signed-in staff member (POST /api/crm/templates/render — variables filled,
// Outlook-safe, signature appended). The Inbox composer asks for the body
// only (signature={false}) and drops it into the message.

import { useEffect, useMemo, useState } from "react";

export type RenderedEmail = { subject: string; html: string; text: string; hasSignature: boolean; missing: string[]; unknown: string[] };
type T = { id: string; name: string; category: string | null; subject: string; needs_review: boolean };

export default function TemplatePicker({
  companyId, contactId, onRendered, signature = true,
}: {
  companyId?: string | null;
  contactId?: string | null;
  onRendered: (r: RenderedEmail | null, templateId: string | null) => void;
  /** false = body only (the composer; composeEmail adds the signature at send). */
  signature?: boolean;
}) {
  const [templates, setTemplates] = useState<T[]>([]);
  const [q, setQ] = useState("");
  const [id, setId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/crm/templates").then((r) => r.json()).then((j) => setTemplates(j.templates ?? [])).catch(() => setErr("Couldn't load templates"));
  }, []);

  useEffect(() => {
    if (!id) { onRendered(null, null); return; }
    let live = true;
    setBusy(true);
    setErr(null);
    fetch("/api/crm/templates/render", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template_id: id, company_id: companyId ?? null, contact_id: contactId ?? null, signature }),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!live) return;
      setBusy(false);
      if (!r.ok) { setErr(j.error ?? "Couldn't render"); onRendered(null, id); return; }
      onRendered(j as RenderedEmail, id);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, companyId, contactId]);

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = templates.filter((t) => !term || t.name.toLowerCase().includes(term) || t.subject.toLowerCase().includes(term));
    const by = new Map<string, T[]>();
    for (const t of list) { const k = t.category || "Uncategorized"; by.set(k, [...(by.get(k) ?? []), t]); }
    return Array.from(by.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [templates, q]);

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <input className="input" placeholder="Filter templates…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 200 }} />
      <select className="input" value={id} onChange={(e) => setId(e.target.value)} style={{ maxWidth: 360 }}>
        <option value="">Choose a template…</option>
        {groups.map(([cat, ts]) => (
          <optgroup key={cat} label={cat}>
            {ts.map((t) => <option key={t.id} value={t.id}>{t.name}{t.needs_review ? " (needs review)" : ""}</option>)}
          </optgroup>
        ))}
      </select>
      {busy && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Rendering…</span>}
      {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
    </div>
  );
}

/** Sandboxed preview of a rendered email + warnings. */
export function RenderedPreview({ r }: { r: RenderedEmail }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 13 }}><span className="label" style={{ display: "inline", marginRight: 6 }}>Subject</span>{r.subject || <em style={{ color: "var(--text-muted)" }}>(no subject)</em>}</div>
      {(r.missing.length > 0 || r.unknown.length > 0 || !r.hasSignature) && (
        <div style={{ fontSize: 12, background: "#fff8e1", color: "#7a5c00", border: "1px solid #ffe082", borderRadius: 4, padding: "6px 10px", display: "grid", gap: 2 }}>
          {r.missing.length > 0 && <span>No value here for: {r.missing.map((m) => `{{${m}}}`).join(", ")} — those spots will be blank.</span>}
          {r.unknown.length > 0 && <span>DA-CRM can&apos;t fill: {r.unknown.join(", ")} — edit the template before sending.</span>}
          {!r.hasSignature && <span>You have no email signature yet — add one on the Team page.</span>}
        </div>
      )}
      <iframe title="Email preview" sandbox="" srcDoc={`<!doctype html><html><body style="margin:12px;background:#fff">${r.html}</body></html>`}
        style={{ width: "100%", height: 380, border: "1px solid var(--border)", borderRadius: 4, background: "#fff" }} />
    </div>
  );
}
