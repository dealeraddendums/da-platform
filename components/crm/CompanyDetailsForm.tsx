"use client";

// Company-level details kept in DA-CRM: notes, emails (a company may only have
// a support@ and no contacts), phone, website; name for partners.

import { useState } from "react";
import { useRouter } from "next/navigation";

type Email = { address: string; label: string | null };

export default function CompanyDetailsForm({
  companyId, isPartner, initial,
}: {
  companyId: string;
  isPartner: boolean;
  initial: { name: string; notes: string | null; emails: Email[]; phone: string | null; website: string | null };
}) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [emails, setEmails] = useState<Email[]>(initial.emails);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const body: Record<string, unknown> = {
      notes, phone, website,
      emails: emails.filter((e) => e.address.trim()),
      ...(isPartner ? { name } : {}),
    };
    const res = await fetch(`/api/crm/companies/${companyId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: "Saved" } : { ok: false, text: j.error ?? "Couldn't save" });
    if (res.ok) router.refresh();
  }

  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      {isPartner && <div><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        <div><label className="label">Company phone</label><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(801) 555-0100" /></div>
        <div><label className="label">Website</label><input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" /></div>
      </div>
      <div>
        <label className="label">Company emails</label>
        {emails.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <input className="input" type="email" placeholder="support@…" value={e.address} onChange={(ev) => setEmails(emails.map((x, j) => j === i ? { ...x, address: ev.target.value } : x))} />
            <input className="input" placeholder="Label (e.g. Support)" style={{ maxWidth: 200 }} value={e.label ?? ""} onChange={(ev) => setEmails(emails.map((x, j) => j === i ? { ...x, label: ev.target.value } : x))} />
            <button type="button" className="btn btn-secondary" onClick={() => setEmails(emails.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setEmails([...emails, { address: "", label: null }])} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 13, padding: 0 }}>+ Add email</button>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea className="input" style={{ height: 140, padding: "8px 12px", resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save details"}</button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}
