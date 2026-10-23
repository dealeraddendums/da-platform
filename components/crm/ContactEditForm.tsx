"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROLE_TAG_LABEL } from "@/lib/crm/format";
import { platformUserHref } from "@/lib/crm/contact-links";

type C = { id: string; company_id: string; user_id?: string | null; verify_reason?: string | null; verified_at?: string | null; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null; role_tag: string | null };

export default function ContactEditForm({ contact, hideVerify = false }: { contact: C; hideVerify?: boolean }) {
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

  const needsVerify = !hideVerify && !!contact.verify_reason && !contact.verified_at;
  if (!open) {
    return (
      <div style={{ marginBottom: 16, display: "flex", gap: 6 }}>
        <button type="button" className="btn btn-secondary" style={{ background: "#fff" }} onClick={() => setOpen(true)}>Edit contact</button>
        {needsVerify && (
          <button type="button" className="btn btn-secondary" disabled={busy} title="This person really is at this company — let their email link here"
            onClick={async () => { if (await send({ verified: true })) router.refresh(); }}>Mark verified</button>
        )}
        {err && <span style={{ fontSize: 12, color: "var(--error)", alignSelf: "center" }}>{err}</span>}
      </div>
    );
  }

  // A platform user's email (and removal) is managed in DA Users — the contact follows the user.
  const isUser = !!contact.user_id;
  const field = (k: keyof typeof f, label: string, type = "text", locked = false) => (
    <div><label className="label">{label}</label>
      <input className="input" type={type} value={f[k]} disabled={locked} title={locked ? "Platform user — edit the email in DA Users" : undefined}
        onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      {locked && <a href={platformUserHref(contact.email)} target="_blank" rel="noreferrer" className="crm-link" style={{ fontSize: 12 }}>Edit in DA Users</a>}
    </div>
  );

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
        {field("first_name", "First name")}{field("last_name", "Last name")}{field("email", "Email", "email", isUser)}
        {field("phone", "Phone", "tel")}{field("title", "Title")}
        <div><label className="label">Role</label>
          <select className="input" value={f.role_tag} onChange={(e) => setF({ ...f, role_tag: e.target.value })}>
            <option value="">—</option>
            {Object.entries(ROLE_TAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => { if (await send(isUser ? { ...f, email: undefined, role_tag: f.role_tag || null } : { ...f, role_tag: f.role_tag || null })) { setOpen(false); router.refresh(); } }}>Save</button>
        <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
        {isUser ? <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)" }}>Platform user — disable or remove in DA Users</span> : <button type="button" className="btn btn-danger" style={{ marginLeft: "auto" }} disabled={busy}
          onClick={async () => { if (window.confirm("Remove this contact?") && await send({ deleted: true })) router.push(`/crm/companies/${contact.company_id}?tab=contacts`); }}>Remove contact</button>}
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
