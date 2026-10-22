"use client";

// "Start feed order" (CompanyContextRail action — from a call, chat, email
// thread or the company page). Every field is optional: saving with gaps makes
// the order "Needs info" plus a "call the GM" task for you, due next business
// day. An open order for the dealer is reused, not duplicated.

import { useEffect, useState } from "react";
import SupplierFieldsInputs from "./SupplierFieldsInputs";
import { checkSupplierFields, type ExtraField } from "@/lib/crm/feeds/extra-fields";

type Supplier = { id: string; name: string; request_method: string; needs_review: boolean; extra_fields?: ExtraField[] };

export default function FeedOrderForm({
  dealerCompanyId, dealerName, emailThreadId, source = "call", defaultApprover, onCreated, onCancel,
}: {
  dealerCompanyId: string;
  dealerName: string;
  emailThreadId?: string | null;
  source?: "call" | "chat" | "email";
  defaultApprover?: { name?: string | null; email?: string | null; phone?: string | null };
  onCreated: (order: { id: string; status: string }, existed: boolean) => void;
  onCancel: () => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [name, setName] = useState(defaultApprover?.name ?? "");
  const [email, setEmail] = useState(defaultApprover?.email ?? "");
  const [phone, setPhone] = useState(defaultApprover?.phone ?? "");
  const [title, setTitle] = useState("");
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [src, setSrc] = useState(source);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { fetch("/api/crm/feeds/suppliers").then((r) => r.json()).then((j) => setSuppliers(j.suppliers ?? [])).catch(() => setSuppliers([])); }, []);

  async function addSupplier() {
    if (!newName.trim()) return;
    setBusy(true); setErr(null);
    const res = await fetch("/api/crm/feeds/suppliers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName, request_email: newEmail || null }) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't add the supplier"); return; }
    setSuppliers((list) => list.some((s) => s.id === j.supplier.id) ? list : [...list, { id: j.supplier.id, name: j.supplier.name, request_method: "email", needs_review: true }].sort((a, b) => a.name.localeCompare(b.name)));
    setSupplierId(j.supplier.id); setAdding(false); setNewName(""); setNewEmail("");
  }

  async function save() {
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setErr("That approver email doesn't look right — fix it or leave it blank."); return; }
    const extraCheck = checkSupplierFields(sel?.extra_fields ?? [], extra);
    if (extraCheck.errors.length) { setErr(extraCheck.errors.join(" ")); return; }
    setBusy(true); setErr(null);
    const res = await fetch("/api/crm/feeds/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dealer_company_id: dealerCompanyId, supplier_company_id: supplierId || null, approver_name: name, approver_email: email, approver_phone: phone, approver_title: title, supplier_fields: sel?.extra_fields?.length ? extra : null, notes, source: src, email_thread_id: emailThreadId ?? null }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't start the order"); return; }
    onCreated(j.order, !!j.existed);
  }

  const sel = suppliers.find((s) => s.id === supplierId);
  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        Upgrade <strong>{dealerName}</strong> to an automatic inventory feed. Fill in what you know — anything missing becomes a &ldquo;call the GM&rdquo; task for you.
      </p>
      <div>
        <label className="label">Feed supplier</label>
        {!adding ? (
          <div style={{ display: "flex", gap: 6 }}>
            <select className="input" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setExtra({}); }}>
              <option value="">Not known yet</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{s.request_method === "api" ? " (portal)" : s.request_method === "pdf" ? " (PDF)" : ""}{s.needs_review ? " · needs review" : ""}</option>)}
            </select>
            <button type="button" className="btn btn-secondary" style={{ whiteSpace: "nowrap" }} onClick={() => setAdding(true)}>Add supplier</button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 6 }}>
            <input className="input" placeholder="Supplier name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input className="input" placeholder="Request email (optional)" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={busy || !newName.trim()} onClick={addSupplier}>Add</button>
            <button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        )}
        {sel?.needs_review && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#b26a00" }}>This supplier&apos;s request address isn&apos;t confirmed yet — a DA-CRM admin checks it on the supplier&apos;s Settings tab.</p>}
      </div>
      {sel && <SupplierFieldsInputs defs={sel.extra_fields ?? []} values={extra} onChange={setExtra} supplierName={sel.name} />}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div><label className="label">Approver name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Who approves at the dealership" /></div>
        <div><label className="label">Approver email</label><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div><label className="label">Approver phone</label><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div><label className="label">Approver title</label><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. General Manager (goes on PDF forms)" /></div>
        <div>
          <label className="label">Came in by</label>
          <select className="input" value={src} onChange={(e) => setSrc(e.target.value as typeof src)}>
            <option value="call">Call / training call</option><option value="email">Email</option><option value="chat">Chat</option>
          </select>
        </div>
      </div>
      <div><label className="label">Notes</label><textarea className="input" style={{ height: 64, padding: "6px 10px", resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Start feed order"}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
