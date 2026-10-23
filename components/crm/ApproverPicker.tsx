"use client";

// Start feed order → Approver. A contact picker over the dealer's contacts (and its group's, labelled
// with the group name): past approvers first, then platform users, "+ New approver" at the bottom.
// Picking fills name / email / phone / title and links the contact to the order. Typing a name that
// isn't a contact shows the manual fields; on Start feed order the server saves that approver as a new
// contact of the dealer, or links the contact that already has the email (lib/crm/feeds/approver.ts).

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApproverCandidate } from "@/lib/crm/feeds/approver";

export type ApproverValue = { contactId: string | null; name: string; email: string; phone: string; title: string };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();

export default function ApproverPicker({ companyId, companyName, value, onChange }: {
  companyId: string; companyName: string; value: ApproverValue; onChange: (v: ApproverValue) => void;
}) {
  const [list, setList] = useState<ApproverCandidate[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  useEffect(() => {
    fetch(`/api/crm/feeds/approvers?company_id=${companyId}`).then((r) => r.json()).then((j) => setList(j.contacts ?? [])).catch(() => setList([]));
  }, [companyId]);

  // A default approver (the thread's sender) that is already a contact → pick it.
  useEffect(() => {
    if (!list || !first.current) return;
    first.current = false;
    if (value.contactId || !value.email) return;
    const hit = list.find((c) => norm(c.email) === norm(value.email));
    if (hit) pick(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  const q = value.contactId ? "" : value.name.trim().toLowerCase();
  const matches = useMemo(() => (list ?? []).filter((c) => !q || [c.name, c.email, c.title].some((x) => norm(x).includes(q))).slice(0, 30), [list, q]);
  const selected = value.contactId ? (list ?? []).find((c) => c.id === value.contactId) ?? null : null;
  const sameEmail = !value.contactId && value.email.trim() ? (list ?? []).find((c) => norm(c.email) === norm(value.email.trim())) : null;

  function pick(c: ApproverCandidate) {
    onChange({ contactId: c.id, name: c.name, email: c.email ?? "", phone: c.phone ?? "", title: c.title ?? "" });
    setOpen(false);
  }
  function newApprover() {
    onChange({ contactId: null, name: "", email: "", phone: "", title: "" });
    setOpen(false);
    setTimeout(() => input.current?.focus(), 0);
  }
  const rows = matches.length + 1;   // + New approver
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + rows) % rows); }
    else if (e.key === "Enter" && open) { e.preventDefault(); if (active < matches.length) pick(matches[active]); else newApprover(); }
    else if (e.key === "Escape") setOpen(false);
  }

  if (selected) {
    return (
      <div>
        <label className="label">Approver</label>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "#fff" }}>
          <div style={{ minWidth: 0, fontSize: 13 }}>
            <strong>{selected.name}</strong>
            {selected.approver && <span className="crm-tag" data-tone="accent" style={{ marginLeft: 6 }}>Approver</span>}
            {selected.company_label && <span style={{ color: "var(--text-muted)" }}> · {selected.company_label}</span>}
            <div style={{ color: "var(--text-muted)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {[selected.title, selected.email, selected.phone].filter(Boolean).join(" · ") || "No email or phone on file"}
            </div>
          </div>
          <button type="button" className="crm-textlink" onClick={() => { onChange({ contactId: null, name: "", email: "", phone: "", title: "" }); setTimeout(() => { input.current?.focus(); setOpen(true); }, 0); }}>Change</button>
        </div>
        {!selected.email && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#b26a00" }}>This contact has no email — add one on the contact, or the order waits in Needs info.</p>}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ position: "relative" }}>
        <label className="label">Approver</label>
        <input ref={input} className="input" value={value.name} placeholder={list?.length ? `Pick from ${companyName}'s contacts, or type a new name` : "Who approves at the dealership"}
          onChange={(e) => { onChange({ ...value, contactId: null, name: e.target.value }); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKey} />
        {open && list && (
          <div role="listbox" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: "calc(100% + 2px)", background: "#fff", border: "1px solid var(--border)", borderRadius: 8, maxHeight: 300, overflowY: "auto" }}>
            {matches.map((c, i) => (
              <div key={c.id} role="option" aria-selected={i === active} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setActive(i)}
                style={{ padding: "7px 10px", cursor: "pointer", background: i === active ? "var(--bg-subtle)" : "#fff", fontSize: 13 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{c.name}</strong>
                  {c.approver && <span className="crm-tag" data-tone="accent">Approver</span>}
                  {c.platform_user && <span className="crm-tag">Platform user</span>}
                  {c.company_label && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{c.company_label}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[c.title, c.email, c.phone].filter(Boolean).join(" · ") || "—"}</div>
              </div>
            ))}
            {!matches.length && value.name.trim() && <div style={{ padding: "7px 10px", fontSize: 12, color: "var(--text-muted)" }}>No contact named &ldquo;{value.name.trim()}&rdquo; — fill in the details below.</div>}
            <div role="option" aria-selected={active === matches.length} onMouseDown={(e) => { e.preventDefault(); newApprover(); }} onMouseEnter={() => setActive(matches.length)}
              style={{ padding: "8px 10px", cursor: "pointer", borderTop: "1px solid var(--border)", color: "var(--blue)", fontSize: 13, fontWeight: 600, background: active === matches.length ? "var(--bg-subtle)" : "#fff" }}>
              + New approver
            </div>
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <div><label className="label">Approver email</label><input className="input" type="email" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} /></div>
        <div><label className="label">Approver phone</label><input className="input" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} /></div>
        <div><label className="label">Approver title</label><input className="input" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="e.g. General Manager" /></div>
      </div>
      {sameEmail
        ? <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>That email belongs to <strong>{sameEmail.name}</strong> — <button type="button" className="crm-textlink" onClick={() => pick(sameEmail)}>use that contact</button>, or start the order and it will be linked.</p>
        : (value.name.trim() || value.email.trim()) && <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Not a contact yet — saved as a new contact of {companyName} when you start the order.</p>}
    </div>
  );
}
