"use client";

// Add a vendor (paper/label supplier, software vendor, association) or a feed
// supplier. No dealer-specific fields — no pipeline, brands or trial.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PartnerForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"vendor" | "feed_supplier">("vendor");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>+ Add partner</button>;

  async function save() {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/crm/companies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name, phone: phone || null, website, emails: email ? [{ address: email, label: "Main" }] : [] }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't add"); return; }
    router.push(`/crm/companies/${j.id}`);
  }

  return (
    <div className="card" style={{ padding: 12, marginBottom: 16, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div><label className="label">Type</label>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "vendor" | "feed_supplier")}>
          <option value="vendor">Vendor</option>
          <option value="feed_supplier">Feed supplier</option>
        </select>
      </div>
      <div style={{ minWidth: 220 }}><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><label className="label">Phone</label><input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
      <div><label className="label">Email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div><label className="label">Website</label><input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} /></div>
      <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? "Saving…" : "Add"}</button>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
    </div>
  );
}
