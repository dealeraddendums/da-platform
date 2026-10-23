"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import EmailEditor from "./EmailEditor";
import { RenderedPreview, type RenderedEmail } from "./TemplatePicker";
import { TEMPLATE_VARIABLES } from "@/lib/crm/template-vars";
import { FEED_KINDS, FEED_KIND_LABEL } from "@/lib/crm/feeds/templates";
import { Tag } from "./CrmBadges";

type Finding = { from: string; to?: string; count: number; why?: string };
type Template = {
  id: string; name: string; category: string | null; subject: string; body_html: string; variables: string[];
  source: string; needs_review: boolean; archived: boolean; updated_at: string;
  feed_kind: string | null; supplier_company_id: string | null;
  import_report: { converted?: Finding[]; approximated?: Finding[]; unmapped?: Finding[] } | null;
};
// feed_kind "" = an ordinary template; set = a "Feed requests" template (global, or a supplier's folder).
type Draft = { id: string | null; name: string; category: string; subject: string; body_html: string; feed_kind: string; supplier_company_id: string };
const EMPTY: Draft = { id: null, name: "", category: "", subject: "", body_html: "", feed_kind: "", supplier_company_id: "" };

async function api(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, j };
}

export default function TemplatesClient({ canEdit, initialCategory = "" }: { canEdit: boolean; initialCategory?: string }) {
  const [list, setList] = useState<Template[]>([]);
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(initialCategory);
  const [sel, setSel] = useState<Template | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { j } = await api(`/api/crm/templates?archived=${archived ? 1 : 0}`);
    setList(j.templates ?? []);
  }, [archived]);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(() => Array.from(new Set(list.map((t) => t.category).filter(Boolean) as string[])).sort(), [list]);
  const shown = list.filter((t) => (!cat || t.category === cat) && (!q.trim() || `${t.name} ${t.subject}`.toLowerCase().includes(q.trim().toLowerCase())));

  async function save() {
    if (!draft) return;
    setMsg(null);
    const body = {
      name: draft.name, category: draft.category || null, subject: draft.subject, body_html: draft.body_html,
      feed_kind: draft.feed_kind || null, supplier_company_id: draft.feed_kind ? draft.supplier_company_id || null : null,
    };
    const { ok, j } = draft.id
      ? await api(`/api/crm/templates/${draft.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      : await api("/api/crm/templates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!ok) { setMsg({ ok: false, text: j.error ?? "Couldn't save" }); return; }
    setMsg({ ok: true, text: j.template.needs_review ? "Saved — it still has tokens DA-CRM can't fill (see below)." : "Saved" });
    setDraft(null);
    setSel(j.template);
    void load();
  }

  async function setArchivedFlag(t: Template, value: boolean) {
    const { ok, j } = await api(`/api/crm/templates/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: value }) });
    if (!ok) { setMsg({ ok: false, text: j.error ?? "Couldn't update" }); return; }
    setSel(null);
    void load();
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <div className="card">
        <div style={{ padding: 12, display: "grid", gap: 8, borderBottom: "1px solid var(--border)" }}>
          {canEdit && (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => { setSel(null); setDraft({ ...EMPTY }); setMsg(null); }}>+ New template</button>
              <button type="button" className="btn btn-secondary" onClick={() => setImporting(true)}>Import</button>
            </div>
          )}
          <input className="input" placeholder="Search name or subject…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center", color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); setSel(null); }} /> Show archived
          </label>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 620, overflowY: "auto" }}>
          {shown.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => { setSel(t); setDraft(null); setMsg(null); }}
                style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderBottom: "1px solid var(--border)", cursor: "pointer", fontFamily: "inherit", background: sel?.id === t.id ? "var(--bg-subtle)" : "#fff", borderLeft: sel?.id === t.id ? "3px solid var(--orange)" : "3px solid transparent" }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: "block" }}>{t.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t.category ?? "Uncategorized"}{t.source === "hubspot_import" ? " · from HubSpot" : ""}
                </span>
                {t.needs_review && <Tag tone="warn" style={{ marginLeft: 6, height: 20, fontSize: 10.5 }}>Needs review</Tag>}
              </button>
            </li>
          ))}
          {!shown.length && <li style={{ padding: 12, fontSize: 13, color: "var(--text-muted)" }}>No templates{archived ? " in the archive" : " yet"}.</li>}
        </ul>
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        {msg && <div className="card" style={{ padding: "8px 12px", fontSize: 13, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</div>}
        {importing && <ImportPanel onClose={() => setImporting(false)} onDone={() => { void load(); }} />}
        {draft ? (
          <EditorPanel draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} />
        ) : sel ? (
          <ViewPanel t={sel} canEdit={canEdit}
            onEdit={() => setDraft({ id: sel.id, name: sel.name, category: sel.category ?? "", subject: sel.subject, body_html: sel.body_html, feed_kind: sel.feed_kind ?? "", supplier_company_id: sel.supplier_company_id ?? "" })}
            onArchive={(v) => setArchivedFlag(sel, v)} />
        ) : !importing && (
          <div className="card" style={{ padding: 24, fontSize: 13, color: "var(--text-secondary)" }}>Pick a template to preview it{canEdit ? ", or create a new one" : ""}.</div>
        )}
      </div>
    </div>
  );
}

function EditorPanel({ draft, setDraft, onSave, onCancel }: { draft: Draft; setDraft: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <strong>{draft.id ? "Edit template" : "New template"}</strong>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <div><label className="label">Name</label><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
        <div><label className="label">Category</label><input className="input" value={draft.feed_kind ? "Feed requests (set automatically)" : draft.category} disabled={!!draft.feed_kind} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="e.g. Trials" /></div>
      </div>
      <FeedFolderFields draft={draft} setDraft={setDraft} />
      <div>
        <label className="label">Subject</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <select className="input" style={{ maxWidth: 170 }} value="" onChange={(e) => { if (e.target.value) setDraft({ ...draft, subject: `${draft.subject}{{${e.target.value}}}` }); }}>
            <option value="">+ Variable</option>
            {TEMPLATE_VARIABLES.map((g) => <optgroup key={g.group} label={g.label}>{g.vars.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</optgroup>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Body</label>
        <EmailEditor value={draft.body_html} onChange={(html) => setDraft({ ...draft, body_html: html })} />
        <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
          Don&apos;t add a signature — the sender&apos;s is appended automatically. Fallback text: <code>{'{{contact.first_name | "there"}}'}</code>.
        </p>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn btn-primary" disabled={busy || !draft.name.trim()} onClick={async () => { setBusy(true); await onSave(); setBusy(false); }}>{busy ? "Saving…" : "Save template"}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
      <Preview subject={draft.subject} body={draft.body_html} feedKind={draft.feed_kind || null} supplierId={draft.supplier_company_id || null} />
    </div>
  );
}

function ViewPanel({ t, canEdit, onEdit, onArchive }: { t: Template; canEdit: boolean; onEdit: () => void; onArchive: (v: boolean) => void }) {
  const r = t.import_report;
  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <strong style={{ fontSize: 16 }}>{t.name}</strong>
          <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
            {t.category ?? "Uncategorized"} · updated {new Date(t.updated_at).toLocaleDateString()}{t.variables.length ? ` · uses ${t.variables.map((v) => `{{${v}}}`).join(" ")}` : ""}
          </p>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8 }}>
            {!t.archived && <button type="button" className="btn btn-primary" onClick={onEdit}>Edit</button>}
            <button type="button" className="btn btn-secondary" onClick={() => onArchive(!t.archived)}>{t.archived ? "Restore" : "Archive"}</button>
          </div>
        )}
      </div>
      {(r?.unmapped?.length || r?.approximated?.length) ? (
        <div style={{ fontSize: 12, background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 4, padding: "8px 10px", color: "#7a5c00", display: "grid", gap: 4 }}>
          {r?.unmapped?.length ? <span><b>Can&apos;t be filled by DA-CRM:</b> {r.unmapped.map((u) => u.from).join(", ")} — edit these out or replace them with a variable.</span> : null}
          {r?.approximated?.length ? <span><b>Converted approximately:</b> {r.approximated.map((a) => `${a.from} → {{${a.to}}}`).join(", ")} ({r.approximated[0].why}).</span> : null}
        </div>
      ) : null}
      <Preview subject={t.subject} body={t.body_html} templateId={t.id} />
    </div>
  );
}

/** Fill the template for a chosen company / contact, as the viewer, with their signature. */
function Preview({ subject, body, templateId, feedKind, supplierId }: { subject: string; body: string; templateId?: string; feedKind?: string | null; supplierId?: string | null }) {
  const [q, setQ] = useState("");
  const [companies, setCompanies] = useState<{ id: string; name: string; kind: string }[]>([]);
  const [company, setCompany] = useState<{ id: string; name: string } | null>(null);
  const [contacts, setContacts] = useState<{ id: string; first_name: string | null; last_name: string | null; email: string | null }[]>([]);
  const [contactId, setContactId] = useState("");
  const [r, setR] = useState<RenderedEmail | null>(null);

  useEffect(() => {
    if (company || q.trim().length < 2) { setCompanies([]); return; }
    const t = setTimeout(async () => setCompanies((await api(`/api/crm/companies/search?q=${encodeURIComponent(q.trim())}`)).j.companies ?? []), 250);
    return () => clearTimeout(t);
  }, [q, company]);
  useEffect(() => {
    setContactId("");
    if (!company) { setContacts([]); return; }
    void api(`/api/crm/companies/search?contacts_for=${company.id}`).then(({ j }) => setContacts(j.contacts ?? []));
  }, [company]);
  useEffect(() => {
    const t = setTimeout(async () => {
      // Feed templates fill supplier / approver / order variables from a sample order.
      const payload = templateId ? { template_id: templateId } : { subject, body_html: body, feed_kind: feedKind ?? null, supplier_company_id: supplierId ?? null };
      const { ok, j } = await api("/api/crm/templates/render", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, company_id: company?.id ?? null, contact_id: contactId || null }),
      });
      setR(ok ? j : null);
    }, 400);
    return () => clearTimeout(t);
  }, [subject, body, templateId, company, contactId, feedKind, supplierId]);

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 13 }}>Preview as sent</strong>
        {!company ? (
          <div style={{ position: "relative" }}>
            <input className="input" style={{ width: 260 }} placeholder="Fill for a dealer, group or partner…" value={q} onChange={(e) => setQ(e.target.value)} />
            {companies.length > 0 && (
              <ul className="card" style={{ position: "absolute", zIndex: 10, top: 38, left: 0, width: 300, listStyle: "none", margin: 0, padding: 0, maxHeight: 240, overflowY: "auto" }}>
                {companies.map((c) => (
                  <li key={c.id}><button type="button" onClick={() => { setCompany(c); setQ(""); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", border: "none", background: "#fff", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>{c.name}</button></li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <span style={{ fontSize: 13 }}>{company.name}</span>
            <button type="button" onClick={() => setCompany(null)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>change</button>
            <select className="input" style={{ maxWidth: 240 }} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">No contact</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}</option>)}
            </select>
          </>
        )}
      </div>
      {r ? <RenderedPreview r={r} /> : <p style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}>Rendering…</p>}
    </div>
  );
}

type ImportResult = {
  dry_run: boolean;
  summary: { rows: number; create: number; update: number; skip: number; failed: number; needs_review: number };
  tokens: { converted: Finding[]; approximated: Finding[]; unmapped: Finding[] };
  results: { row: number; name: string; action: string; problem?: string; needs_review: boolean; unmapped: string[] }[];
};

function ImportPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setErr(null);
    const fd = new FormData();
    fd.append("file", file);
    if (overwrite) fd.append("overwrite", "1");
    if (dryRun) fd.append("dry_run", "1");
    const { ok, j } = await api("/api/crm/templates/import", { method: "POST", body: fd });
    setBusy(false);
    if (!ok) { setErr(j.error ?? "Import failed"); return; }
    setRes(j);
    if (!dryRun) onDone();
  }

  const TH: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600, textAlign: "left", padding: "4px 8px" };
  return (
    <div className="card" style={{ padding: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>Import HubSpot email templates</strong>
        <button type="button" className="btn btn-secondary" style={{ height: 28 }} onClick={onClose}>Close</button>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        CSV with columns <code>name</code>, <code>subject</code>, <code>body_html</code>, <code>folder</code>. HubSpot tokens such as <code>{"{{contact.firstname}}"}</code> are converted to DA-CRM variables; anything that can&apos;t be converted is kept as-is, flagged “Needs review” and listed below. Check first, then import.
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input type="file" accept=".csv,text/csv" style={{ fontSize: 13 }} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRes(null); }} />
        <label style={{ fontSize: 13, display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={overwrite} onChange={(e) => { setOverwrite(e.target.checked); setRes(null); }} /> Replace templates with the same name
        </label>
        <button type="button" className="btn btn-secondary" disabled={!file || busy} onClick={() => run(true)}>{busy ? "Checking…" : "Check file"}</button>
        {res?.dry_run && (res.summary.create + res.summary.update) > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(false)}>Import {res.summary.create + res.summary.update} template{res.summary.create + res.summary.update === 1 ? "" : "s"}</button>
        )}
      </div>
      {err && <p style={{ margin: 0, fontSize: 13, color: "var(--error)" }}>{err}</p>}
      {res && (
        <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
          <p style={{ margin: 0, fontWeight: 600, color: res.dry_run ? "var(--text-primary)" : "var(--success)" }}>
            {res.dry_run ? "Check: " : "Imported: "}{res.summary.create} new · {res.summary.update} replaced · {res.summary.skip} skipped{res.summary.failed ? ` · ${res.summary.failed} failed` : ""} · {res.summary.needs_review} need review
          </p>
          {res.tokens.unmapped.length > 0 && (
            <div style={{ background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 4, padding: "8px 10px" }}>
              <b>Unmapped tokens (kept as typed — fix before sending):</b>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{res.tokens.unmapped.map((u) => <li key={u.from}><code>{u.from}</code> × {u.count}</li>)}</ul>
            </div>
          )}
          {res.tokens.approximated.length > 0 && (
            <div><b>Converted approximately:</b> {res.tokens.approximated.map((a) => <span key={a.from}><code>{a.from}</code> → <code>{`{{${a.to}}}`}</code> × {a.count}; </span>)}<span style={{ color: "var(--text-muted)" }}> {res.tokens.approximated[0].why}.</span></div>
          )}
          {res.tokens.converted.length > 0 && (
            <div style={{ color: "var(--text-secondary)" }}><b>Converted:</b> {res.tokens.converted.map((c) => `${c.from} → {{${c.to}}} ×${c.count}`).join(" · ")}</div>
          )}
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "1px solid var(--border)" }}><th style={TH}>Row</th><th style={TH}>Template</th><th style={TH}>Action</th><th style={TH}>Notes</th></tr></thead>
            <tbody>
              {res.results.map((r) => (
                <tr key={r.row} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "4px 8px", color: "var(--text-muted)" }}>{r.row}</td>
                  <td style={{ padding: "4px 8px" }}>{r.name || <em>(no name)</em>}</td>
                  <td style={{ padding: "4px 8px", color: r.action === "failed" ? "var(--error)" : r.action === "skip" ? "var(--text-muted)" : "var(--text-primary)" }}>{r.action}</td>
                  <td style={{ padding: "4px 8px", fontSize: 12, color: "var(--text-secondary)" }}>{[r.problem, r.unmapped.length ? `unmapped: ${r.unmapped.join(", ")}` : null].filter(Boolean).join(" · ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "Feed requests" placement: kind + global default or a supplier's folder. */
function FeedFolderFields({ draft, setDraft }: { draft: Draft; setDraft: (d: Draft) => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { void api("/api/crm/feeds/suppliers").then(({ j }) => setSuppliers(j.suppliers ?? [])); }, []);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <label className="label">Feed request kind</label>
        <select className="input" value={draft.feed_kind} onChange={(e) => setDraft({ ...draft, feed_kind: e.target.value })}>
          <option value="">— Not a feed template —</option>
          {FEED_KINDS.map((k) => <option key={k} value={k}>{FEED_KIND_LABEL[k]}</option>)}
        </select>
      </div>
      {draft.feed_kind && (
        <div>
          <label className="label">Folder</label>
          <select className="input" value={draft.supplier_company_id} onChange={(e) => setDraft({ ...draft, supplier_company_id: e.target.value })}>
            <option value="">Global default (all suppliers)</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name} (override)</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
