"use client";

// Dealer Billing tab. Two scenarios:
//   - subscription_billed_to === "group": show a simple info card pointing
//     at the group admin. No invoice data is exposed.
//   - subscription_billed_to === "dealer": pull the customer + invoices
//     via /api/billing/dealers/[dealerId] (server-side proxy to lib/billing.ts)
//     and show outstanding + history sections.
//
// Layout mirrors GroupBillingTab.tsx (same card styling, same Pay-link
// orange CTA, same history-collapsed-by-default). Never calls da-billing
// directly from the browser; BILLING_API_KEY stays server-side.

import { useCallback, useEffect, useState } from "react";

interface DealerBillingDealer {
  id: string;
  dealer_id: string;
  name: string;
  billing_customer_id: string | null;
  subscription_billed_to: "dealer" | "group";
  group: { id: string; name: string } | null;
  subscriptionTier: string | null;
}

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

type DealerBillingData =
  | {
      scenario: "group_billed";
      dealer: DealerBillingDealer;
    }
  | {
      scenario: "dealer_billed";
      dealer: DealerBillingDealer;
      customer: BillingCustomerDetail | null;
      outstandingInvoices: BillingInvoice[];
      paidInvoices: BillingInvoice[];
      outstandingAmount: number;
    };

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

interface Props {
  dealerId: string;
  /** Role of the viewer — drives the "no billing account" copy + Create button. */
  viewerRole: "super_admin" | "group_admin" | "dealer_admin" | string;
}

export default function DealerBillingTab({ dealerId, viewerRole }: Props) {
  const [data, setData] = useState<DealerBillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ id: string; company: string | null; email: string | null }> | null>(null);

  // super_admin (any), a switched-in group_admin (in-group), and dealer_admin
  // (own) can create/link a billing customer. dealer_user is read-only.
  const canManageBilling = viewerRole === "super_admin" || viewerRole === "group_admin" || viewerRole === "dealer_admin";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/billing/dealers/${encodeURIComponent(dealerId)}`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        setError(j.error ?? `Failed to load (${res.status})`);
        setData(null);
        return;
      }
      const j = await res.json() as DealerBillingData;
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, [dealerId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // One call for all three actions: initial create attempt (no body), link a
  // surfaced candidate (linkCustomerId), or override the soft-match block
  // (forceCreate). A 409 possible_existing_customer surfaces candidates to link.
  async function postCreate(payload?: { linkCustomerId?: string; forceCreate?: boolean }) {
    setCreating(true);
    setToast(null);
    try {
      const res = await fetch(`/api/billing/dealers/${encodeURIComponent(dealerId)}/create-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      const j = await res.json().catch(() => ({})) as {
        error?: string; message?: string; linked?: boolean;
        candidates?: Array<{ id: string; company: string | null; email: string | null }>;
      };
      if (res.status === 409 && j.error === "possible_existing_customer") {
        setCandidates(j.candidates ?? []);
        setToast(j.message ?? "Possible existing customer — review below.");
        return;
      }
      if (!res.ok) {
        setToast(j.error ?? `Failed (${res.status})`);
        return;
      }
      setCandidates(null);
      setToast(j.linked ? "✓ Linked existing billing account" : "✓ Billing account created");
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

  // ── Scenario A: group billed ─────────────────────────────────────────────
  if (data.scenario === "group_billed") {
    const groupName = data.dealer.group?.name ?? "your dealer group";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 24,
          background: "#fff",
        }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: "#2a2b3c", marginBottom: 8 }}>
            Subscription: {data.dealer.subscriptionTier ?? "Subscription"}
          </div>
          <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6, margin: 0 }}>
            Billed by your group: <strong>{groupName}</strong>.
            Contact your group admin for billing changes.
          </p>
        </div>
      </div>
    );
  }

  // ── Scenario B: dealer billed ────────────────────────────────────────────
  const outstanding = data.outstandingInvoices;
  const paid = data.paidInvoices;

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

      {/* No customer yet */}
      {!data.dealer.billing_customer_id && (
        <div style={{
          padding: 20,
          background: "#fff8e1",
          border: "1px solid #ffe082",
          borderRadius: 6,
        }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: "#7a5c00", marginBottom: 6 }}>
            Billing account not set up
          </div>
          {canManageBilling ? (
            <>
              {/* Candidate picker (shown after a 409 possible_existing_customer) */}
              {candidates && candidates.length > 0 ? (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 13, color: "#7a5c00", marginBottom: 10, lineHeight: 1.5 }}>
                    A matching billing customer may already exist. Link it instead of creating a duplicate:
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
                    {candidates.map((c) => (
                      <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 12px", background: "#fff", border: "1px solid #ffe082", borderRadius: 4 }}>
                        <div style={{ fontSize: 13, color: "#333", minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{c.company ?? "(no name)"}</div>
                          <div style={{ color: "#78828c", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{c.email ?? ""} · <span style={{ fontFamily: "monospace" }}>{c.id}</span></div>
                        </div>
                        <button onClick={() => void postCreate({ linkCustomerId: c.id })} disabled={creating}
                          style={{ flexShrink: 0, padding: "6px 12px", background: "#2e7d32", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: creating ? "wait" : "pointer", fontFamily: "inherit", opacity: creating ? 0.6 : 1 }}>
                          Link this customer
                        </button>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => void postCreate({ forceCreate: true })} disabled={creating}
                    style={{ padding: "7px 14px", background: "#fff", color: "#7a5c00", border: "1px solid #ffb300", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: creating ? "wait" : "pointer", fontFamily: "inherit", opacity: creating ? 0.6 : 1 }}>
                    None of these — create a new customer
                  </button>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: 13, color: "#7a5c00", marginBottom: 14, lineHeight: 1.5 }}>
                    This dealer does not have a da-billing customer record yet. Create one to view contact details, outstanding invoices, and payment history.
                  </div>
                  <button
                    onClick={() => void postCreate()}
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
                    {creating ? "Working…" : "Create Billing Account"}
                  </button>
                </>
              )}
            </>
          ) : (
            <div style={{ fontSize: 13, color: "#7a5c00", lineHeight: 1.5 }}>
              Billing account not yet configured. Contact{" "}
              <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2", textDecoration: "underline" }}>
                DealerAddendums support
              </a>.
            </div>
          )}
        </div>
      )}

      {/* Outstanding Invoices */}
      {data.dealer.billing_customer_id && (
        <div style={{
          border: outstanding.length > 0 ? "1px solid #ffcdd2" : "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 20,
          background: "#fff",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: outstanding.length > 0 ? "#c62828" : "#2a2b3c" }}>
              {outstanding.length > 0
                ? `Outstanding Balance: ${money(data.outstandingAmount)}`
                : "Outstanding Invoices"}
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
            <InvoiceTable rows={outstanding} variant="outstanding" baseUrl={`/api/billing/dealers/${data.dealer.id}/invoices`} />
          )}
        </div>
      )}

      {/* Payment History (collapsed by default) */}
      {data.dealer.billing_customer_id && (
        <div style={{
          border: "1px solid #e0e0e0",
          borderRadius: 6,
          padding: 20,
          background: "#fff",
        }}>
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
            <span style={{ fontWeight: 600, fontSize: 15 }}>Payment History</span>
            <span style={{ fontSize: 12, color: "#78828c" }}>
              {paid.length} paid · {historyOpen ? "Hide" : "Show"}
            </span>
          </button>
          {historyOpen && (
            <div style={{ marginTop: 14 }}>
              {paid.length === 0 ? (
                <div style={{ fontSize: 13, color: "#78828c" }}>No paid invoices yet.</div>
              ) : (
                <InvoiceTable rows={paid} variant="history" baseUrl={`/api/billing/dealers/${data.dealer.id}/invoices`} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function invoiceActions(baseUrl: string, inv: BillingInvoice) {
  const link = { fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600 } as const;
  return (
    <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
      <a href={`${baseUrl}/${inv.id}/pdf`} target="_blank" rel="noreferrer" style={link}>View</a>
      <a href={`${baseUrl}/${inv.id}/pdf?download=1`} style={link}>Download</a>
    </span>
  );
}

function InvoiceTable({ rows, variant, baseUrl }: { rows: BillingInvoice[]; variant: "outstanding" | "history"; baseUrl: string }) {
  const headerColor = variant === "outstanding" ? "#c62828" : "#78828c";
  const borderColor = variant === "outstanding" ? "#ffcdd2" : "#e0e0e0";
  const headers = variant === "outstanding"
    ? ["Invoice #", "Period", "Amount", "Due Date", ""]
    : ["Invoice #", "Period", "Amount", "Status", ""];

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
            <td style={{ padding: "8px 10px", fontFamily: "monospace", color: "#333" }}>{money(inv.total)}</td>
            {variant === "outstanding" ? (
              <>
                <td style={{ padding: "8px 10px", color: inv.status === "overdue" ? "#c62828" : "#555" }}>{fmtDate(inv.dueDate)}</td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>
                  <span style={{ display: "inline-flex", gap: 12, alignItems: "center" }}>
                    {invoiceActions(baseUrl, inv)}
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
                  </span>
                </td>
              </>
            ) : (
              <>
                <td style={{ padding: "8px 10px" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", textTransform: "uppercase", letterSpacing: ".04em" }}>
                    Paid
                  </span>
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right" }}>{invoiceActions(baseUrl, inv)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
