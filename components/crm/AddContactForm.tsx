"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_TAG_LABEL } from "@/lib/crm/format";

const EMPTY = { first_name: "", last_name: "", email: "", phone: "", title: "", role_tag: "" };

export default function AddContactForm({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return <button type="button" className="btn btn-primary" style={{ height: 30, fontSize: 13 }} onClick={() => setOpen(true)}>+ Add contact</button>;
  }

  async function save() {
    setSaving(true);
    setErr(null);
    const res = await fetch("/api/crm/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: companyId, ...f, role_tag: f.role_tag || null }),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't add the contact"); return; }
    setF(EMPTY);
    setOpen(false);
    router.refresh();
  }

  const field = (k: keyof typeof EMPTY, label: string, type = "text") => (
    <div>
      <label className="label">{label}</label>
      <input className="input" type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </div>
  );

  return (
    <div style={{ padding: 16, borderTop: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {field("first_name", "First name")}
        {field("last_name", "Last name")}
        {field("email", "Email", "email")}
        {field("phone", "Phone", "tel")}
        {field("title", "Title")}
        <div>
          <label className="label">Role</label>
          <select className="input" value={f.role_tag} onChange={(e) => setF({ ...f, role_tag: e.target.value })}>
            <option value="">—</option>
            {Object.entries(ROLE_TAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !f.first_name.trim()}>{saving ? "Saving…" : "Save contact"}</button>
        <button type="button" className="btn btn-secondary" onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
