"use client";

// "Start feed order" (CompanyContextRail action — from a call, chat, email
// thread or the company page). Every field is optional: saving with gaps makes
// the order "Needs info" plus a "call the GM" task for you, due next business
// day. An open order for the dealer is reused, not duplicated. The approver is picked from the dealer's
// contacts (ApproverPicker) or typed in — then saved as a contact of the dealer.
// From a GROUP: tick the rooftops the request covers (one email, one approver);
// the supplier's per-dealership questions (Autosoft account) are asked per
// rooftop, and a PDF supplier gets one form per rooftop or one for all.

import { useEffect, useState } from "react";
import SupplierFieldsInputs from "./SupplierFieldsInputs";
import ApproverPicker, { type ApproverValue } from "./ApproverPicker";
import { checkOrderFields, isPerDealership, type ExtraField } from "@/lib/crm/feeds/extra-fields";

type Supplier = { id: string; name: string; request_method: string; needs_review: boolean; extra_fields?: ExtraField[] };
type Rooftop = { id: string; name: string; city: string | null; state: string | null; active: boolean; open_order_number: string | null };

export default function FeedOrderForm({
  dealerCompanyId, dealerName, companyKind = "dealer", emailThreadId, source = "call", defaultApprover, onCreated, onCancel,
}: {
  dealerCompanyId: string;
  dealerName: string;
  /** "group": pick the rooftops. */
  companyKind?: "dealer" | "group";
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
  const [approver, setApprover] = useState<ApproverValue>({
    contactId: null, name: defaultApprover?.name ?? "", email: defaultApprover?.email ?? "", phone: defaultApprover?.phone ?? "", title: "",
  });
  const { name, email, phone, title } = approver;
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [rooftops, setRooftops] = useState<Rooftop[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [perRoof, setPerRoof] = useState<Record<string, Record<string, string>>>({});
  const [pdfMode, setPdfMode] = useState<"per_dealership" | "combined">("per_dealership");
  const group = companyKind === "group";
  const [notes, setNotes] = useState("");
  const [src, setSrc] = useState(source);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { fetch("/api/crm/feeds/suppliers").then((r) => r.json()).then((j) => setSuppliers(j.suppliers ?? [])).catch(() => setSuppliers([])); }, []);
  useEffect(() => {
    if (!group) return;
    fetch(`/api/crm/feeds/rooftops?group_company_id=${dealerCompanyId}`).then((r) => r.json()).then((j) => setRooftops(j.rooftops ?? [])).catch(() => setRooftops([]));
  }, [group, dealerCompanyId]);

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
    if (group && !picked.length) { setErr("Tick the dealerships this request is for."); return; }
    const extraCheck = checkOrderFields(sel?.extra_fields ?? [], extra, group ? picked.map((id) => ({ name: roofName(id), fields: perRoof[id] })) : [{ name: dealerName, fields: extra }]);
    if (extraCheck.errors.length) { setErr(extraCheck.errors.join(" ")); return; }
    setBusy(true); setErr(null);
    const res = await fetch("/api/crm/feeds/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dealer_company_id: dealerCompanyId, supplier_company_id: supplierId || null, approver_contact_id: approver.contactId, approver_name: name, approver_email: email, approver_phone: phone, approver_title: title,
        supplier_fields: sel?.extra_fields?.length ? extra : null, notes, source: src, email_thread_id: emailThreadId ?? null,
        ...(group ? { dealership_company_ids: picked, dealership_fields: Object.fromEntries(picked.map((id) => [id, perRoof[id] ?? {}])), pdf_mode: pdfMode } : {}),
      }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't start the order"); return; }
    onCreated(j.order, !!j.existed);
  }

  const sel = suppliers.find((s) => s.id === supplierId);
  const roofName = (id: string) => rooftops?.find((r) => r.id === id)?.name ?? "Dealership";
  const defs = sel?.extra_fields ?? [];
  // A group order asks the per-dealership questions once per ticked rooftop.
  const requestDefs = group ? defs.filter((f) => !isPerDealership(f)) : defs;
  const roofDefs = group ? defs.filter(isPerDealership) : [];
  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>
        Upgrade <strong>{dealerName}</strong>{group ? "’s dealerships" : ""} to an automatic inventory feed. Fill in what you know — anything missing becomes a &ldquo;call the GM&rdquo; task for you.
      </p>
      {group && (
        <div>
          <label className="label">Dealerships on this request</label>
          {!rooftops ? <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Loading…</p> : !rooftops.length ? <p style={{ margin: 0, fontSize: 12, color: "#b26a00" }}>This group has no dealerships in DA-CRM.</p> : (
            <div style={{ display: "grid", gap: 4 }}>
              {rooftops.map((r) => (
                <label key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, opacity: r.open_order_number ? 0.55 : 1 }}>
                  <input type="checkbox" disabled={!!r.open_order_number} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} />
                  <span>{r.name}{r.city ? <span style={{ color: "var(--text-muted)" }}> · {r.city}, {r.state}</span> : null}{!r.active && <span style={{ color: "var(--text-muted)" }}> · inactive</span>}{r.open_order_number && <span style={{ color: "var(--text-muted)" }}> · already on {r.open_order_number}</span>}</span>
                </label>
              ))}
            </div>
          )}
          <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--text-muted)" }}>One email and one approver for all of them; each dealership gets its own Feed ID.</p>
        </div>
      )}
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
      {sel && <SupplierFieldsInputs defs={requestDefs} values={extra} onChange={setExtra} supplierName={sel.name} />}
      {sel && roofDefs.length > 0 && picked.map((id) => (
        <SupplierFieldsInputs key={id} defs={roofDefs} values={perRoof[id] ?? {}} onChange={(v) => setPerRoof({ ...perRoof, [id]: v })} supplierName={`${sel.name} · ${roofName(id)}`} />
      ))}
      {sel?.request_method === "pdf" && group && picked.length > 1 && (
        <div>
          <label className="label">Authorization forms</label>
          <select className="input" value={pdfMode} onChange={(e) => setPdfMode(e.target.value as typeof pdfMode)}>
            <option value="per_dealership">One form per dealership, all attached to one email</option>
            <option value="combined">One form for all of them (the dealer uses one account)</option>
          </select>
        </div>
      )}
      <ApproverPicker companyId={dealerCompanyId} companyName={dealerName} value={approver} onChange={setApprover} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
