"use client";

// Compose window TO / CC / BCC (EmailComposer). Tokenized chips; paste a comma / semicolon list; typing
// suggests CRM contacts (this company's first — GET /api/crm/compose/recipients). Every chip is resolved
// (POST, same route) and anything that needs a decision is listed under the field:
//   contact at ANOTHER company → "Also add as contact of {company}" (default on for dealer-domain addresses)
//   not in the CRM            → add as a contact here (first / last / title) or as a new company; a domain
//                               that belongs to a known company suggests adding them there
// Sending without choosing is fine: the address stays on the thread and can be linked later.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecipientContact, RecipientDomainCompany, ResolvedRecipient } from "@/lib/crm/recipients";

export type RecipientChip = { email: string; name?: string | null; info?: ResolvedRecipient | null; alsoAdd?: boolean };
export type ComposeCompany = { id: string; name: string } | null;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** "Jane Doe <jane@x.com>; bob@y.com" → chips (lowercased, deduped) + what isn't an address. */
export function parseRecipientText(text: string): { list: RecipientChip[]; bad: string[] } {
  const list: RecipientChip[] = [], bad: string[] = [];
  for (const part of text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(part);
    const email = (m ? m[2] : part).trim().toLowerCase().replace(/^mailto:/, "");
    const name = m ? m[1].trim().replace(/^"|"$/g, "") || null : null;
    if (EMAIL.test(email)) { if (!list.some((r) => r.email === email)) list.push({ email, name }); }
    else bad.push(part);
  }
  return { list, bad };
}

/** Resolve chips the server hasn't classified yet. */
export async function resolveChips(chips: RecipientChip[], companyId: string | null): Promise<Record<string, ResolvedRecipient>> {
  const emails = chips.filter((c) => !c.info).map((c) => c.email);
  if (!emails.length) return {};
  const j = await fetch("/api/crm/compose/recipients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ emails, company_id: companyId }) })
    .then((r) => r.json()).catch(() => ({}));
  return Object.fromEntries((j.recipients ?? []).map((r: ResolvedRecipient) => [r.email, r]));
}

export default function RecipientField({ label, value, onChange, company, autoFocus }: {
  label: string; value: RecipientChip[]; onChange: (next: RecipientChip[]) => void; company: ComposeCompany; autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [sugg, setSugg] = useState<RecipientContact[]>([]);
  const [active, setActive] = useState(0);
  const [bad, setBad] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(value);
  latest.current = value;
  const companyId = company?.id ?? null;

  // Suggestions (debounced). Empty input + a company → that company's contacts.
  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(async () => {
      const qs = new URLSearchParams({ q: text.trim() });
      if (companyId) qs.set("company_id", companyId);
      const j = await fetch(`/api/crm/compose/recipients?${qs}`).then((r) => r.json()).catch(() => ({}));
      if (live) { setSugg((j.contacts ?? []).filter((c: RecipientContact) => !latest.current.some((v) => v.email === c.email))); setActive(0); }
    }, text.trim() ? 180 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [text, open, companyId]);

  // Classify new chips (each address asked once; reresolve() asks again after a contact is added).
  const tried = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const todo = value.filter((c) => !c.info && !tried.current.has(c.email));
    if (!todo.length) return;
    todo.forEach((c) => tried.current.add(c.email));
    // Not cancelled when `value` changes (a chip added meanwhile) — the merge reads the latest chips.
    void resolveChips(todo, companyId).then((map) => {
      if (!mounted.current || !Object.keys(map).length) return;
      onChange(latest.current.map((c) => {
        const info = c.info ?? map[c.email];
        if (!info) return c;
        // "Also add as contact here" defaults on for dealer-domain addresses, off for the rest.
        return { ...c, info, name: c.name ?? info.contact?.name ?? null, alsoAdd: c.alsoAdd ?? (info.status === "elsewhere" && info.dealerDomain) };
      }));
    });
  }, [value, companyId, onChange]);

  const add = useCallback((chips: RecipientChip[]) => {
    const next = [...latest.current];
    for (const c of chips) if (!next.some((v) => v.email === c.email)) next.push(c);
    onChange(next);
  }, [onChange]);

  function commit(raw = text): boolean {
    if (!raw.trim()) return false;
    const p = parseRecipientText(raw);
    add(p.list);
    setBad(p.bad);
    setText(p.bad.join(", "));
    return true;
  }
  const pick = (c: RecipientContact) => {
    add([{ email: c.email, name: c.name }]);
    setText(""); setBad([]); input.current?.focus();
  };
  const update = (email: string, patch: Partial<RecipientChip>) => onChange(latest.current.map((c) => (c.email === email ? { ...c, ...patch } : c)));
  const reresolve = (email: string) => { tried.current.delete(email); update(email, { info: null, alsoAdd: undefined }); };

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && sugg.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + sugg.length) % sugg.length);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (open && sugg.length && text.trim() && !EMAIL.test(text.trim())) { e.preventDefault(); pick(sugg[active]); return; }
      if (open && sugg.length && !text.trim() && e.key === "Enter") { e.preventDefault(); pick(sugg[active]); return; }
      if (commit()) e.preventDefault();
    } else if (e.key === "," || e.key === ";") {
      e.preventDefault(); commit();
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const needs = value.filter((c) => c.info && (c.info.status === "elsewhere" || c.info.status === "none"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "64px 1fr", gap: 8, alignItems: "start" }}>
      <span className="label" style={{ margin: 0, paddingTop: 7 }}>{label}</span>
      <div style={{ position: "relative", minWidth: 0 }}>
        <div className="input" onClick={() => input.current?.focus()}
          style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", height: "auto", minHeight: 36, padding: "3px 6px", cursor: "text" }}>
          {value.map((c) => <Chip key={c.email} chip={c} onRemove={() => onChange(value.filter((v) => v.email !== c.email))} />)}
          <input ref={input} value={text} autoFocus={autoFocus} aria-label={label}
            onChange={(e) => { setText(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => { setOpen(false); commit(); }}
            onKeyDown={onKey}
            onPaste={(e) => {
              const t = e.clipboardData.getData("text");
              if (/[,;\n]/.test(t) || EMAIL.test(t.trim())) { e.preventDefault(); commit(text + t); }
            }}
            placeholder={value.length ? "" : companyId ? "Name or email — this company's contacts first" : "Name or email"}
            style={{ flex: "1 1 160px", minWidth: 120, border: 0, outline: 0, background: "transparent", font: "inherit", padding: "4px 2px" }} />
        </div>
        {open && sugg.length > 0 && (
          <div role="listbox" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 2px)", background: "#fff", border: "1px solid var(--border)", borderRadius: 8, maxHeight: 280, overflowY: "auto" }}>
            {sugg.map((c, i) => (
              <div key={c.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(i)}
                style={{ padding: "7px 10px", cursor: "pointer", background: i === active ? "var(--bg-subtle)" : "#fff", fontSize: 13, display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 }}>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {[c.title, c.email, companyId && c.company_id === companyId ? null : c.company_name].filter(Boolean).join(" · ")}
                </span>
              </div>
            ))}
          </div>
        )}
        {bad.length > 0 && <div style={{ fontSize: 12, color: "var(--error)", marginTop: 4 }}>Not an email address: {bad.join(", ")}</div>}
        {needs.length > 0 && (
          <div style={{ display: "grid", gap: 6, marginTop: 6 }}>
            {needs.map((c) => <Decision key={c.email} chip={c} company={company} onAlsoAdd={(v) => update(c.email, { alsoAdd: v })} onAdded={() => reresolve(c.email)} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ chip, onRemove }: { chip: RecipientChip; onRemove: () => void }) {
  const s = chip.info?.status;
  const tone = s === "none" ? { bg: "var(--crm-warn-soft, #fbf1e0)", border: "#f1dfbf" } : { bg: "var(--bg-subtle)", border: "var(--border)" };
  const tip = chip.info?.contact ? `${chip.info.contact.name} — ${chip.info.contact.company_name}` : s === "none" ? "Not in CRM" : chip.email;
  return (
    <span title={`${chip.email}${tip !== chip.email ? ` · ${tip}` : ""}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", fontSize: 12.5, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 999, padding: "2px 4px 2px 9px" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {chip.name ? <><strong style={{ fontWeight: 600 }}>{chip.name}</strong> <span style={{ color: "var(--text-muted)" }}>{chip.email}</span></> : chip.email}
      </span>
      <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }} aria-label={`Remove ${chip.email}`}
        style={{ background: "none", border: 0, cursor: "pointer", color: "var(--text-muted)", padding: "0 3px", fontSize: 14, lineHeight: 1 }}>×</button>
    </span>
  );
}

/** One line under the field for a chip that needs a decision. */
function Decision({ chip, company, onAlsoAdd, onAdded }: {
  chip: RecipientChip; company: ComposeCompany; onAlsoAdd: (v: boolean) => void; onAdded: () => void;
}) {
  const info = chip.info!;
  const [form, setForm] = useState<null | { kind: "contact"; target: { id: string; name: string } } | { kind: "company" }>(null);
  const box: React.CSSProperties = { fontSize: 12.5, border: "1px solid var(--border)", borderRadius: 8, padding: "7px 10px", background: "#fff" };
  if (info.status === "elsewhere" && info.contact) {
    const c = info.contact;
    return (
      <div style={box}>
        <strong>{c.name}</strong> <span style={{ color: "var(--text-muted)" }}>— Contact at {c.company_name}{info.others.length ? ` (+${info.others.length} more)` : ""}</span>
        {company && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={!!chip.alsoAdd} onChange={(e) => onAlsoAdd(e.target.checked)} />
            Also add as contact of {company.name}
          </label>
        )}
      </div>
    );
  }
  const hint: RecipientDomainCompany | undefined = info.domainCompanies[0];
  return (
    <div style={box}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <span><span className="crm-tag" data-tone="warn">Not in CRM</span> <span style={{ color: "var(--text-muted)" }}>{chip.email}</span></span>
        {company && <button type="button" className="crm-textlink" onClick={() => setForm({ kind: "contact", target: company })}>Add as contact of {company.name}</button>}
        {hint && hint.id !== company?.id && (
          <button type="button" className="crm-textlink" onClick={() => setForm({ kind: "contact", target: hint })}>Domain matches {hint.name} — add as contact there</button>
        )}
        <button type="button" className="crm-textlink" onClick={() => setForm({ kind: "company" })}>Add as new company</button>
      </div>
      {form?.kind === "contact" && <InlineContactForm email={chip.email} name={chip.name} company={form.target} onDone={() => { setForm(null); onAdded(); }} onCancel={() => setForm(null)} />}
      {form?.kind === "company" && <InlineCompanyForm email={chip.email} name={chip.name} onDone={() => { setForm(null); onAdded(); }} onCancel={() => setForm(null)} />}
    </div>
  );
}

function guessName(name: string | null | undefined, email: string): { first: string; last: string } {
  const d = (name ?? "").trim();
  if (d && !d.includes("@")) { const p = d.split(/\s+/); return { first: p[0], last: p.slice(1).join(" ") }; }
  const bits = email.split("@")[0].replace(/\d+$/, "").split(/[._-]+/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase());
  return bits.length > 1 ? { first: bits[0], last: bits.slice(1).join(" ") } : { first: "", last: "" };
}

async function createContact(companyId: string, f: { first: string; last: string; title: string }, email: string): Promise<string | null> {
  const r = await fetch("/api/crm/contacts", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company_id: companyId, first_name: f.first, last_name: f.last || null, title: f.title || null, email }) });
  if (r.ok) return null;
  return (await r.json().catch(() => ({}))).error ?? "Couldn't add the contact";
}

function InlineContactForm({ email, name, company, onDone, onCancel }: { email: string; name?: string | null; company: { id: string; name: string }; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ ...guessName(name, email), title: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    const e = await createContact(company.id, f, email);
    setBusy(false);
    if (e) setErr(e); else onDone();
  }
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>New contact at <strong>{company.name}</strong> · {email}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        <input className="input" placeholder="First name" value={f.first} onChange={(e) => setF({ ...f, first: e.target.value })} autoFocus />
        <input className="input" placeholder="Last name" value={f.last} onChange={(e) => setF({ ...f, last: e.target.value })} />
        <input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" style={{ height: 28, fontSize: 12 }} disabled={busy || !f.first.trim()} onClick={save}>{busy ? "Adding…" : "Add contact"}</button>
        <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={onCancel}>Cancel</button>
        {err && <span style={{ color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}

function InlineCompanyForm({ email, name, onDone, onCancel }: { email: string; name?: string | null; onDone: () => void; onCancel: () => void }) {
  const domain = email.split("@")[1] ?? "";
  const [f, setF] = useState({ company: "", kind: "vendor" as "vendor" | "feed_supplier", ...guessName(name, email), title: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    const r = await fetch("/api/crm/companies", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: f.kind, name: f.company.trim(), website: domain ? `https://${domain}` : null }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setBusy(false); setErr(j.error ?? "Couldn't add the company"); return; }
    const e = f.first.trim() ? await createContact(j.id, f, email) : null;
    setBusy(false);
    if (e) setErr(`Company added; ${e}`); else onDone();
  }
  return (
    <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)", gap: 6 }}>
        <input className="input" placeholder="Company name" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoFocus />
        <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "vendor" | "feed_supplier" })}>
          <option value="vendor">Vendor</option>
          <option value="feed_supplier">Feed supplier</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        <input className="input" placeholder="First name" value={f.first} onChange={(e) => setF({ ...f, first: e.target.value })} />
        <input className="input" placeholder="Last name" value={f.last} onChange={(e) => setF({ ...f, last: e.target.value })} />
        <input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Dealers and groups are created on the platform — this adds a vendor or feed supplier, with {email} as its contact.</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" style={{ height: 28, fontSize: 12 }} disabled={busy || !f.company.trim()} onClick={save}>{busy ? "Adding…" : "Add company"}</button>
        <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={onCancel}>Cancel</button>
        {err && <span style={{ color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
