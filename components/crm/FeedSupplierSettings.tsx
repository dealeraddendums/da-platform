"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

// Feed supplier → Settings tab: how requests go out (email / PDF / portal),
// where (request + Cc addresses), the PDF template and field map, the Feed ID
// regex, typical turnaround, the platform provider name written to the dealer
// record, and how this supplier behaves (its mail domains, case numbers,
// cancellation deadlines, its own approval wording, the questions an order asks).
// Team Velocity / vAuto / Autosoft are seeded from lib/crm/feeds/suppliers.ts. "Test render" fills the request for a sample dealer; "Edit
// templates" opens this supplier's Feed requests folder. crm_admin edits.

import { useEffect, useRef, useState } from "react";
import { RenderedPreview, type RenderedEmail } from "./TemplatePicker";
import { FEED_KINDS, FEED_KIND_LABEL } from "@/lib/crm/feeds/templates";

export default function FeedSupplierSettings({ supplierId, supplierName, canEdit }: { supplierId: string; supplierName: string; canEdit: boolean }) {
  const [s, setS] = useState<any>(null);
  const [providers, setProviders] = useState<{ dms: string[]; other: string[] }>({ dms: [], other: [] });
  const [overrides, setOverrides] = useState<{ id: string; name: string; feed_kind: string }[]>([]);
  const [map, setMap] = useState("");
  const [cc, setCc] = useState("");
  const [lists, setLists] = useState({ domains: "", approval_phrases: "", cancellation_patterns: "", extra_fields: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<string[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    const j = await fetch(`/api/crm/feeds/suppliers/${supplierId}`).then((r) => r.json()).catch(() => ({}));
    setS(j.settings); setProviders(j.providers ?? { dms: [], other: [] }); setOverrides(j.overrides ?? []);
    setMap(JSON.stringify(j.settings?.pdf_field_map ?? {}, null, 2)); setCc((j.settings?.cc_emails ?? []).join(", "));
    setLists({
      domains: (j.settings?.domains ?? []).join(", "), approval_phrases: (j.settings?.approval_phrases ?? []).join("\n"),
      cancellation_patterns: (j.settings?.cancellation_patterns ?? []).join("\n"), extra_fields: JSON.stringify(j.settings?.extra_fields ?? [], null, 2),
    });
  }
  useEffect(() => { void load(); }, [supplierId]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    let pdfMap: unknown;
    try { pdfMap = JSON.parse(map || "{}"); } catch { setMsg({ ok: false, text: "The PDF field map isn't valid JSON" }); return; }
    let extraFields: unknown;
    try { extraFields = JSON.parse(lists.extra_fields || "[]"); } catch { setMsg({ ok: false, text: "The order questions aren't valid JSON" }); return; }
    const lines = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/crm/feeds/suppliers/${supplierId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      ...s, cc_emails: cc, pdf_field_map: pdfMap, extra_fields: extraFields,
      domains: lists.domains, approval_phrases: lines(lists.approval_phrases), cancellation_patterns: lines(lists.cancellation_patterns),
    }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: j.error ?? "Couldn't save" }); return; }
    setMsg({ ok: true, text: "Saved" }); void load();
  }
  async function upload(f: File) {
    setBusy(true);
    const form = new FormData(); form.append("file", f);
    const res = await fetch(`/api/crm/feeds/suppliers/${supplierId}/pdf-template`, { method: "POST", body: form });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: j.error ?? "Upload failed" }); return; }
    setFields(j.fields); setMsg({ ok: true, text: `Template uploaded — ${j.fields.length} fillable fields` }); void load();
  }

  if (!s) return <p style={{ padding: 16, fontSize: 13, color: "var(--text-muted)" }}>Loading…</p>;
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const dis = !canEdit || busy;
  const folder = encodeURIComponent(`Feed requests · ${supplierName}`);
  return (
    <div style={{ padding: 16, display: "grid", gap: 14, fontSize: 13 }}>
      {s.needs_review && <p className="crm-notice" style={{ margin: 0, fontSize: 12 }}>Needs review — confirm the request address and method, then untick &ldquo;Needs review&rdquo;.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        <div><label className="label">Request method</label>
          <select className="input" value={s.request_method} disabled={dis} onChange={(e) => set("request_method", e.target.value)}>
            <option value="email">Email — dealer replies APPROVED</option><option value="pdf">PDF — dealer signs a form</option><option value="api">Supplier portal (CDK, Tekion…)</option>
          </select></div>
        <div><label className="label">Request email</label><input className="input" value={s.request_email ?? ""} disabled={dis} onChange={(e) => set("request_email", e.target.value)} placeholder="feeds@supplier.com" /></div>
        <div><label className="label">Also Cc</label><input className="input" value={cc} disabled={dis} onChange={(e) => setCc(e.target.value)} placeholder="a@supplier.com, b@supplier.com" /></div>
        <div><label className="label">Typical turnaround (business days)</label><input className="input" type="number" min={0} max={60} value={s.typical_turnaround_days} disabled={dis} onChange={(e) => set("typical_turnaround_days", Number(e.target.value))} /></div>
        <div><label className="label">Provider name on the dealer record</label>
          <select className="input" value={s.platform_provider ?? ""} disabled={dis} onChange={(e) => set("platform_provider", e.target.value || null)}>
            <option value="">— {supplierName} —</option>
            <optgroup label="DMS">{providers.dms.map((p) => <option key={p} value={p}>{p}</option>)}</optgroup>
            <optgroup label="Website / inventory">{providers.other.map((p) => <option key={p} value={p}>{p}</option>)}</optgroup>
          </select></div>
        <div style={{ display: "flex", gap: 16, alignItems: "flex-end" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!s.is_dms} disabled={dis} onChange={(e) => set("is_dms", e.target.checked)} /> DMS feed</label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!s.needs_review} disabled={dis} onChange={(e) => set("needs_review", e.target.checked)} /> Needs review</label>
        </div>
      </div>
      <div><label className="label">Feed ID pattern (regular expression; group 1 = the ID)</label>
        <input className="input" style={{ fontFamily: "monospace" }} value={s.feed_id_pattern ?? ""} disabled={dis} onChange={(e) => set("feed_id_pattern", e.target.value)} placeholder="e.g. \b(MP\d{3,6})\b — blank uses the generic rules" />
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Blank = the generic rules (&ldquo;Feed ID: …&rdquo;, &ldquo;under the ID …&rdquo;, &ldquo;Dealer ID is …&rdquo;). Detected IDs are always confirmed by staff.</p></div>
      {s.request_method === "pdf" && (
        <div style={{ display: "grid", gap: 6 }}>
          <label className="label">PDF template</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>{s.pdf_template_s3_key ? "Uploaded" : "None yet"}{fields ? ` · fields: ${fields.join(", ")}` : ""}</span>
            <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
            {canEdit && <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => fileRef.current?.click()}>Upload fillable PDF</button>}
          </div>
          <label className="label">Field map (PDF field → value with {"{{variables}}"})</label>
          <textarea className="input" style={{ height: 140, padding: 8, fontFamily: "monospace", fontSize: 12 }} value={map} disabled={dis} onChange={(e) => setMap(e.target.value)} />
        </div>
      )}
      <details>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>How this supplier behaves</summary>
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
            <div><label className="label">Mail domains (beyond the request / Cc addresses)</label><input className="input" value={lists.domains} disabled={dis} onChange={(e) => setLists({ ...lists, domains: e.target.value })} placeholder="supplier.com — subdomains match too" /></div>
            <div><label className="label">Case number pattern (group 1)</label><input className="input" style={{ fontFamily: "monospace" }} value={s.case_number_pattern ?? ""} disabled={dis} onChange={(e) => set("case_number_pattern", e.target.value)} placeholder={"case\\s*#\\s*(\\d+)"} /></div>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!s.followup_new_thread} disabled={dis} onChange={(e) => set("followup_new_thread", e.target.checked)} /> Supplier follow-up is a new email (closed cases ignore replies — vAuto)</label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={!!s.feed_id_manual} disabled={dis} onChange={(e) => set("feed_id_manual", e.target.checked)} /> Feed IDs are entered by hand (no reliable ID in replies)</label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div><label className="label">Its own approval wording (one per line, on top of the global phrases)</label><textarea className="input" style={{ height: 60, padding: 8 }} value={lists.approval_phrases} disabled={dis} onChange={(e) => setLists({ ...lists, approval_phrases: e.target.value })} placeholder="I approve" /></div>
            <div><label className="label">Cancellation deadline patterns (regex, one per line)</label><textarea className="input" style={{ height: 60, padding: 8, fontFamily: "monospace", fontSize: 12 }} value={lists.cancellation_patterns} disabled={dis} onChange={(e) => setLists({ ...lists, cancellation_patterns: e.target.value })} /></div>
          </div>
          <div><label className="label">Order questions (JSON — asked on Start feed order, used as {"{{order.supplier_fields.<key>}}"})</label>
            <textarea className="input" style={{ height: 120, padding: 8, fontFamily: "monospace", fontSize: 12 }} value={lists.extra_fields} disabled={dis} onChange={(e) => setLists({ ...lists, extra_fields: e.target.value })} /></div>
        </div>
      </details>
      <div><label className="label">Notes</label><textarea className="input" style={{ height: 60, padding: 8 }} value={s.notes ?? ""} disabled={dis} onChange={(e) => set("notes", e.target.value)} /></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {canEdit && <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save settings"}</button>}
        <a className="btn btn-secondary" href={`/crm/communications/templates?folder=${folder}`}>Edit templates</a>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Overrides: {overrides.length ? overrides.map((o) => FEED_KIND_LABEL[o.feed_kind as (typeof FEED_KINDS)[number]] ?? o.feed_kind).join(", ") : "none — uses the global Feed requests templates"}</span>
        {!canEdit && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>A DA-CRM admin edits supplier settings.</span>}
        {msg && <span style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</span>}
      </div>
      <TestRender supplierId={supplierId} />
    </div>
  );
}

function TestRender({ supplierId }: { supplierId: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [kind, setKind] = useState("");
  const [out, setOut] = useState<{ rendered: RenderedEmail; templateSource: string; to: string[]; cc: string[]; pdf: any } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(async () => setHits(((await fetch(`/api/crm/companies/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).catch(() => ({}))).companies ?? []).filter((c: any) => c.kind === "dealer")), 250);
    return () => clearTimeout(t);
  }, [q]);
  async function render(dealerId: string) {
    setHits([]); setErr(null);
    const res = await fetch(`/api/crm/feeds/suppliers/${supplierId}/test-render`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealer_company_id: dealerId, kind: kind || undefined }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? "Couldn't render"); return; }
    setOut(j);
  }
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", position: "relative" }}>
        <strong>Test render</strong>
        <select className="input" style={{ maxWidth: 220 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Request (by method)</option>
          {FEED_KINDS.map((k) => <option key={k} value={k}>{FEED_KIND_LABEL[k]}</option>)}
        </select>
        <input className="input" style={{ width: 260 }} placeholder="Sample dealer…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
          <div className="card" style={{ position: "absolute", top: 40, left: 360, zIndex: 10, width: 300, maxHeight: 220, overflowY: "auto", padding: 4 }}>
            {hits.map((h) => <button key={h.id} type="button" onClick={() => { setQ(h.name); void render(h.id); }} style={{ display: "block", width: "100%", textAlign: "left", border: "none", background: "none", padding: "6px 8px", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}>{h.name}</button>)}
          </div>
        )}
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
      {out && (
        <>
          <div style={{ fontSize: 12 }}>To {out.to.join(", ")} · Cc {out.cc.join(", ") || "—"} · template: {out.templateSource === "built_in" ? "built-in default" : out.templateSource}</div>
          <RenderedPreview r={out.rendered} />
          {out.pdf && <a download="feed-request-test.pdf" href={`data:application/pdf;base64,${out.pdf.base64}`} style={{ color: "var(--blue)", fontSize: 12 }}>📎 Filled PDF{out.pdf.sample ? " (built-in sample form)" : ""}{out.pdf.missingFields?.length ? ` · not in the PDF: ${out.pdf.missingFields.join(", ")}` : ""}</a>}
        </>
      )}
    </div>
  );
}
