"use client";

// Group Billing tab — appears between Users and Corporate Products on
// /groups/[id]. Pulls from /api/billing/groups/[groupId] (which hits
// da-billing via lib/billing.ts). All editing flows through API routes —
// the browser never talks to da-billing directly and BILLING_API_SECRET
// never reaches the client bundle.

import { useCallback, useEffect, useState } from "react";

interface BillingCustomerDetail {
  id: string;
  name?: string;
  company?: string;
  email?: string;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  isGroup?: boolean | null;
}

interface BillingInvoice {
  id: string;
  invoiceNumber?: string | number;
  date: string;
  dueDate?: string;
  total: number;
  status: string;
  paymentUrl?: string;
}

interface GroupBillingData {
  group: { id: string; name: string; billing_customer_id: string | null };
  customer: BillingCustomerDetail | null;
  invoices: BillingInvoice[];
  outstandingAmount: number;
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function GroupBillingTab({ groupId }: { groupId: string }) {
  const [data, setData] = useState<GroupBillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/groups/${encodeURIComponent(groupId)}`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Failed to load (${res.status})`);
        setData(null);
        return;
      }
      const json = await res.json() as GroupBillingData;
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createCustomer() {
    setCreating(true);
    setToast(null);
    try {
      const res = await fetch(`/api/billing/groups/${encodeURIComponent(groupId)}/create-customer`, { method: "POST" });
      const j = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setToast(j.error ?? `Failed (${res.status})`);
        return;
      }
      setToast("✓ Billing account created");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <div style={{ padding: 24, textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading…</div>;
  if (error || !data) {
    return (
      <div style={{ padding: 12, background: "#ffebee", border: "1px solid #ffcdd2", color: "#c62828", borderRadius: 6, fontSize: 13 }}>
        {error ?? "Failed to load billing"}
      </div>
    );
  }

  const outstanding = data.invoices.filter(inv => inv.status === "pending" || inv.status === "overdue");
  const paid = data.invoices.filter(inv => inv.status === "paid");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {toast && (
        <div style={{
          padding: "10px 14px",
          background: toast.startsWith("✓") ? "#e8f5e9" : "#ffebee",
          border: `1px solid ${toast.startsWith("✓") ? "#c8e6c9" : "#ffcdd2"}`,
          color: toast.startsWith("✓") ? "#2e7d32" : "#c62828",
          borderRadius: 6,
          fontSize: 13,
        }}>
          {toast}
        </div>
      )}

      {/* ── No customer warning ──────────────────────────────────────────── */}
      {!data.group.billing_customer_id && (
        <div style={{
          padding: 20,
          background: "#fff8e1",
          border: "1px solid #ffe082",
          borderRadius: 6,
        }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#7a5c00", marginBottom: 6 }}>
            Billing account not set up
          </div>
          <div style={{ fontSize: 13, color: "#7a5c00", marginBottom: 14, lineHeight: 1.5 }}>
            This group does not have a da-billing customer record yet. Create one to
            view contact details, outstanding invoices, and payment history.
          </div>
          <button
            onClick={() => void createCustomer()}
            disabled={creating}
            style={{
              padding: "8px 16px",
              background: "#1976d2",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: creating ? "wait" : "pointer",
              fontFamily: "inherit",
              opacity: creating ? 0.6 : 1,
            }}
          >
            {creating ? "Creating…" : "Create Billing Account"}
          </button>
        </div>
      )}

      {/* ── Billing Contact ──────────────────────────────────────────────── */}
      {data.customer && (
        <BillingContactCard
          groupId={groupId}
          customer={data.customer}
          editing={editing}
          onEdit={() => setEditing(true)}
          onCancel={() => setEditing(false)}
          onSaved={(msg) => { setEditing(false); setToast(msg); void refresh(); }}
          onError={(msg) => setToast(msg)}
        />
      )}

      {/* ── Outstanding Invoices ─────────────────────────────────────────── */}
      {data.customer && (
        <div style={{ border: outstanding.length > 0 ? "1px solid #ffcdd2" : "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: outstanding.length > 0 ? "#c62828" : "#2a2b3c" }}>
              {outstanding.length > 0 ? `Outstanding Balance: ${money(data.outstandingAmount)}` : "Outstanding Invoices"}
            </div>
            {outstanding.length > 0 && (
              <div style={{ fontSize: 11, color: "#c62828", textTransform: "uppercase", letterSpacing: ".05em" }}>
                {outstanding.length} invoice{outstanding.length === 1 ? "" : "s"} due
              </div>
            )}
          </div>
          {outstanding.length === 0 ? (
            <div style={{ fontSize: 13, color: "#78828c" }}>No outstanding invoices.</div>
          ) : (
            <InvoiceTable rows={outstanding} variant="outstanding" />
          )}
        </div>
      )}

      {/* ── Invoice History (collapsed by default) ───────────────────────── */}
      {data.customer && (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
          <button
            onClick={() => setHistoryOpen(v => !v)}
            style={{
              width: "100%",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
              color: "#2a2b3c",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 15 }}>Invoice History</span>
            <span style={{ fontSize: 12, color: "#78828c" }}>
              {paid.length} paid · {historyOpen ? "Hide" : "Show"}
            </span>
          </button>
          {historyOpen && (
            <div style={{ marginTop: 14 }}>
              {paid.length === 0 ? (
                <div style={{ fontSize: 13, color: "#78828c" }}>No paid invoices yet.</div>
              ) : (
                <InvoiceTable rows={paid} variant="history" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Billing Contact Card ──────────────────────────────────────────────────────

function BillingContactCard({
  groupId,
  customer,
  editing,
  onEdit,
  onCancel,
  onSaved,
  onError,
}: {
  groupId: string;
  customer: BillingCustomerDetail;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [draft, setDraft] = useState({
    name:    customer.name    ?? "",
    email:   customer.email   ?? "",
    phone:   customer.phone   ?? "",
    address: customer.address ?? "",
    city:    customer.city    ?? "",
    state:   customer.state   ?? "",
    zip:     customer.zip     ?? "",
    country: customer.country ?? "",
  });
  const [saving, setSaving] = useState(false);

  // Reset draft when toggling edit mode on
  useEffect(() => {
    if (editing) {
      setDraft({
        name:    customer.name    ?? "",
        email:   customer.email   ?? "",
        phone:   customer.phone   ?? "",
        address: customer.address ?? "",
        city:    customer.city    ?? "",
        state:   customer.state   ?? "",
        zip:     customer.zip     ?? "",
        country: customer.country ?? "",
      });
    }
  }, [editing, customer]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(`/api/billing/groups/${encodeURIComponent(groupId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        onError(j.error ?? `Save failed (${res.status})`);
        return;
      }
      onSaved("✓ Billing contact updated");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c" }}>Billing Contact</div>
        {!editing ? (
          <button
            onClick={onEdit}
            style={{ padding: "6px 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
          >
            Edit
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onCancel}
              disabled={saving}
              style={{ padding: "6px 14px", background: "#fff", color: "#333", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              style={{ padding: "6px 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit", opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>

      {!editing ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 13 }}>
          <Field label="Contact Name" value={customer.name} />
          <Field label="Email" value={customer.email} />
          <Field label="Phone" value={customer.phone} />
          <Field label="Address" value={customer.address} />
          <Field label="City" value={customer.city} />
          <Field label="State" value={customer.state} />
          <Field label="ZIP" value={customer.zip} />
          <Field label="Country" value={customer.country} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 13 }}>
          <Input label="Contact Name" value={draft.name}    onChange={v => setDraft(d => ({ ...d, name: v }))} />
          <Input label="Email"        value={draft.email}   onChange={v => setDraft(d => ({ ...d, email: v }))} type="email" />
          <Input label="Phone"        value={draft.phone}   onChange={v => setDraft(d => ({ ...d, phone: v }))} />
          <Input label="Address"      value={draft.address} onChange={v => setDraft(d => ({ ...d, address: v }))} />
          <Input label="City"         value={draft.city}    onChange={v => setDraft(d => ({ ...d, city: v }))} />
          <Input label="State"        value={draft.state}   onChange={v => setDraft(d => ({ ...d, state: v }))} />
          <Input label="ZIP"          value={draft.zip}     onChange={v => setDraft(d => ({ ...d, zip: v }))} />
          <Input label="Country"      value={draft.country} onChange={v => setDraft(d => ({ ...d, country: v }))} />
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#333" }}>{value && value.trim() !== "" ? value : "—"}</div>
    </div>
  );
}

function Input({
  label, value, onChange, type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "8px 10px",
          height: 36,
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          background: "#fff",
          fontSize: 13,
          color: "#333",
          fontFamily: "inherit",
        }}
      />
    </div>
  );
}

// ── Invoice tables ────────────────────────────────────────────────────────────

function InvoiceTable({ rows, variant }: { rows: BillingInvoice[]; variant: "outstanding" | "history" }) {
  const headerColor = variant === "outstanding" ? "#c62828" : "#78828c";
  const borderColor = variant === "outstanding" ? "#ffcdd2" : "#e0e0e0";
  const headers = variant === "outstanding"
    ? ["Invoice #", "Date", "Due", "Amount", ""]
    : ["Invoice #", "Date", "Amount", "Status"];

  return (
    <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${borderColor}`, textAlign: "left" }}>
          {headers.map(h => (
            <th key={h} style={{ padding: "6px 10px", fontSize: 11, fontWeight: 700, color: headerColor, textTransform: "uppercase", letterSpacing: ".04em" }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((inv, i) => (
          <tr key={inv.id} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${variant === "outstanding" ? "#ffe6e6" : "#f5f5f5"}` : "none" }}>
            <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>#{inv.invoiceNumber ?? inv.id.slice(0, 8)}</td>
            <td style={{ padding: "8px 10px", color: "#555" }}>{fmtDate(inv.date)}</td>
            {variant === "outstanding" ? (
              <>
                <td style={{ padding: "8px 10px", color: inv.status === "overdue" ? "#c62828" : "#555" }}>{fmtDate(inv.dueDate)}</td>
                <td style={{ padding: "8px 10px", fontFamily: "monospace", color: "#333" }}>{money(inv.total)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                  {inv.paymentUrl && (
                    <a
                      href={inv.paymentUrl}
                      target="_blank"
                      rel="noreferrer"
                      style={{ padding: "5px 14px", background: "#ffa500", color: "#fff", borderRadius: 4, fontSize: 12, fontWeight: 600, textDecoration: "none", display: "inline-block" }}
                    >
                      Pay
                    </a>
                  )}
                </td>
              </>
            ) : (
              <>
                <td style={{ padding: "8px 10px", fontFamily: "monospace", color: "#333" }}>{money(inv.total)}</td>
                <td style={{ padding: "8px 10px" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", textTransform: "uppercase", letterSpacing: ".04em" }}>
                    Paid
                  </span>
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
