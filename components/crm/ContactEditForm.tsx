"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_TAG_LABEL } from "@/lib/crm/format";

type C = { id: string; company_id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null; role_tag: string | null };

export default function ContactEditForm({ contact }: { contact: C }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    first_name: contact.first_name ?? "", last_name: contact.last_name ?? "", email: contact.email ?? "",
    phone: contact.phone ?? "", title: contact.title ?? "", role_tag: contact.role_tag ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/crm/contacts/${contact.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save"); return false; }
    return true;
  }

  if (!open) {
    return <div style={{ marginBottom: 16 }}><button type="button" className="btn btn-secondary" style={{ background: "#fff" }} onClick={() => setOpen(true)}>Edit contact</button></div>;
  }

  const field = (k: keyof typeof f, label: string, type = "text") => (
    <div><label className="label">{label}</label><input className="input" type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
  );

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {field("first_name", "First name")}{field("last_name", "Last name")}{field("email", "Email", "email")}
        {field("phone", "Phone", "tel")}{field("title", "Title")}
        <div><label className="label">Role</label>
          <select className="input" value={f.role_tag} onChange={(e) => setF({ ...f, role_tag: e.target.value })}>
            <option value="">—</option>
            {Object.entries(ROLE_TAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (await send({ ...f, role_tag: f.role_tag || null })) { setOpen(false); router.refresh(); } }}>Save</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="btn btn-danger" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={async () => { if (window.confirm("Remove this contact?") && await send({ deleted: true })) router.push(`/crm/companies/${contact.company_id}?tab=contacts`); }}>Remove contact</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
