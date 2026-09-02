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
import { formatBillingDate } from "@/lib/billing-date";

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

interface SubscriptionInfo {
  productId: string | null;
  name: string | null;
  price: number | null;
  nextInvoiceDate: string | null;
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
      subscription: SubscriptionInfo | null;
      pricing: Array<{ name: string; price: number }>;
    };

// Mirrors ProfileClient's SUBSCRIPTION_TIERS. Values are the da-billing product
// keys; the PATCH receives productKey and da-billing resolves the price.
const SUBSCRIPTION_TIERS: Array<{ key: string; productKey: string; name: string; description: string }> = [
  { key: "manual",    productKey: "sub-manual",   name: "Monthly Subscription Manual",        description: "Manual data entry — addendums created one at a time" },
  { key: "auto-web",  productKey: "sub-auto-web", name: "Monthly Subscription Automatic Web", description: "Automatic ingest from your website inventory feed" },
  { key: "auto-dms",  productKey: "sub-auto-dms", name: "Monthly Subscription Automatic DMS", description: "Direct DMS integration — fastest sync" },
];

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const fmtDate = formatBillingDate;

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
  const [changeOpen, setChangeOpen] = useState(false);
  const [savingTier, setSavingTier] = useState<string | null>(null);
  // Conversion confirm: a non-paying dealer being moved onto a paid plan.
  const [pendingTier, setPendingTier] = useState<{ key: string; productKey: string; name: string } | null>(null);
  // Downgrade-to-Free flow (mirrors ProfileClient): null = idle, "reason" =
  // collecting the soft reason / confirm, "closing" = POST in flight.
  const [closeStep, setCloseStep] = useState<null | "reason" | "closing">(null);
  const [closeReason, setCloseReason] = useState<string>("");
  const [closeDetail, setCloseDetail] = useState<string>("");

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

  // Change/set the plan via the SAME endpoint the dealer side uses. Acting on
  // another dealer requires the TEXT dealer_id (data.dealer.dealer_id), NOT the
  // route UUID. The PATCH sends only the productKey — no price (da-billing is the
  // price authority) — and auto-provisions/links the customer + template when
  // none exists. For a Trial dealer this is a LIVE conversion to paid, identical
  // to the dealer doing it themselves.
  async function changeTier(dealerTextId: string, tier: { key: string; productKey: string; name: string }) {
    setSavingTier(tier.key);
    setToast(null);
    try {
      const res = await fetch(`/api/billing/me/subscription?dealer_id=${encodeURIComponent(dealerTextId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier: tier.productKey }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) {
        setToast(j.error ?? "Plan change failed");
        return;
      }
      setToast(`✓ Plan updated to ${tier.name}. Takes effect on the next invoice.`);
      setChangeOpen(false);
      setCandidates(null);
      await refresh();
    } finally {
      setSavingTier(null);
    }
  }

  // Downgrade to Free / close — reuses POST /api/billing/me/close (super_admin via
  // ?dealer_id=, in-group group_admin). NO new cancel logic. The endpoint sets
  // account_type=Free + downgraded_at, deletes the da-billing template (recurring
  // stops now; +60-day cron archives), pushes HubSpot Downgraded, keeps log-in for
  // 60 days. A 409 balance_due is surfaced as a pay-first message.
  async function closeAccount(dealerTextId: string) {
    setCloseStep("closing");
    setToast(null);
    try {
      const res = await fetch(`/api/billing/me/close?dealer_id=${encodeURIComponent(dealerTextId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: closeReason || undefined, detail: closeDetail || undefined }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; message?: string; outstandingAmount?: number };
      if (!res.ok) {
        // 409 balance_due carries a pay-first message + amount; show it and keep
        // the dealer on their plan (no downgrade until $0).
        setToast(j.message ?? j.error ?? "Downgrade failed");
        setCloseStep("reason");
        return;
      }
      setToast("✓ Downgraded to Free. Recurring billing cancelled; log-in continues for 60 days.");
      setCloseStep(null);
      setChangeOpen(false);
      await refresh();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Downgrade failed");
      setCloseStep("reason");
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

      {/* Current Subscription + Change Plan — mirrors My Profile → Billing.
          Gated on canManageBilling (super_admin / in-group group_admin /
          dealer_admin); dealer_user is read-only. When there's no customer yet,
          this picker is the primary "set up billing" path (picking a tier
          provisions via the PATCH); the dup-safe link flow stays below. */}
      {canManageBilling && (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: 20, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: "#2a2b3c" }}>Current Subscription</div>
            <button
              onClick={() => setChangeOpen((v) => !v)}
              style={{ padding: "6px 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
            >
              {changeOpen ? "Cancel" : data.subscription ? "Change Plan" : "Set Plan"}
            </button>
          </div>
          {data.subscription ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, fontSize: 13 }}>
              <div>
                <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Plan</div>
                <div style={{ color: "#333" }}>
                  {data.subscription.name ?? SUBSCRIPTION_TIERS.find(t => t.productKey === data.subscription!.productId)?.name ?? "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Price</div>
                <div style={{ color: "#333", fontFamily: "monospace" }}>{money(data.subscription.price)}/month</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 4 }}>Next Invoice</div>
                <div style={{ color: "#333" }}>{fmtDate(data.subscription.nextInvoiceDate)}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: "#78828c" }}>
              No active subscription (Trial / Free). Pick a plan to {data.dealer.billing_customer_id ? "start" : "set up"} billing.
            </div>
          )}

          {changeOpen && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f0f0f0" }}>
              <div style={{ fontSize: 12, color: "#78828c", marginBottom: 10 }}>
                Choose a plan. The change takes effect on the next invoice — no proration for the current period.
                {!data.subscription && " Setting a plan for a Trial dealer converts them to paid (live)."}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {SUBSCRIPTION_TIERS.map((tier) => {
                  const priceEntry = data.pricing.find((p) => p.name.toLowerCase() === tier.productKey.toLowerCase());
                  const tierPrice = priceEntry?.price ?? null;
                  const isCurrent = data.subscription?.productId === tier.productKey;
                  const isSaving = savingTier === tier.key;
                  return (
                    <button
                      key={tier.key}
                      disabled={isCurrent || isSaving}
                      onClick={() => {
                        // Conversion case (no active paid plan) → confirm first.
                        // An already-paying dealer's tier swap stays one-click.
                        if (!data.subscription) { setPendingTier(tier); return; }
                        void changeTier(data.dealer.dealer_id, tier);
                      }}
                      style={{
                        textAlign: "left", padding: "10px 14px",
                        border: `1px solid ${isCurrent ? "#1976d2" : "#e0e0e0"}`,
                        background: isCurrent ? "#e3f2fd" : "#fff",
                        borderRadius: 6, cursor: isCurrent ? "default" : isSaving ? "wait" : "pointer",
                        fontFamily: "inherit", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, color: "#333" }}>
                          {tier.name}
                          {isCurrent && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#1565c0" }}>CURRENT</span>}
                        </div>
                        <div style={{ fontSize: 11, color: "#78828c", marginTop: 2 }}>{tier.description}</div>
                      </div>
                      <div style={{ fontFamily: "monospace", fontSize: 13, color: "#333", whiteSpace: "nowrap" }}>
                        {isSaving ? "Saving…" : `${money(tierPrice)}/mo`}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Downgrade to Free / close — only for a dealer currently on a paid
              plan (subscription present). Hidden for Trial/Free (nothing to
              downgrade). Blocks on an outstanding balance before opening. */}
          {data.subscription && (
            <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #f5f5f5" }}>
              <button
                onClick={() => {
                  if (data.outstandingAmount > 0) {
                    setToast(`Settle the balance (${money(data.outstandingAmount)}) before downgrading — see Outstanding Invoices below.`);
                    return;
                  }
                  setCloseReason("");
                  setCloseDetail("");
                  setCloseStep("reason");
                }}
                disabled={closeStep !== null}
                style={{ padding: "7px 12px", background: "#fff", color: "#c62828", border: "1px solid #ffcdd2", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: closeStep !== null ? "default" : "pointer", fontFamily: "inherit" }}
              >
                Downgrade to Free / close account
              </button>
              <div style={{ fontSize: 11, color: "#9aa4ad", marginTop: 6, lineHeight: 1.5 }}>
                Cancels recurring billing immediately. Log-in continues for 60 days (view only), then the account is archived. Requires a $0 balance.
              </div>
            </div>
          )}
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
                    Picking a plan above sets up this dealer&apos;s billing automatically. Use this only if they may
                    <strong> already have a da-billing customer</strong> — we&apos;ll check for matches so you can link it
                    instead of creating a duplicate.
                  </div>
                  <button
                    onClick={() => void postCreate()}
                    disabled={creating}
                    style={{
                      padding: "8px 16px",
                      background: "#fff",
                      color: "#7a5c00",
                      border: "1px solid #ffb300",
                      borderRadius: 4,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: creating ? "wait" : "pointer",
                      fontFamily: "inherit",
                      opacity: creating ? 0.6 : 1,
                    }}
                  >
                    {creating ? "Working…" : "Check for an existing customer"}
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

      {/* ── Conversion confirm (PART A) — only when converting a non-paying dealer ── */}
      {pendingTier && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}
        >
          <div style={{ background: "#fff", borderRadius: 6, width: 460, maxWidth: "94vw", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Convert to a paid plan</span>
              <button onClick={() => setPendingTier(null)} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: 20 }}>
              <p style={{ fontSize: 13, color: "#333", margin: "0 0 16px", lineHeight: 1.6 }}>
                This will convert <strong>{data.dealer.name}</strong> to a paying <strong>{pendingTier.name}</strong> plan and start billing on the 1st of next month. Continue?
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  onClick={() => setPendingTier(null)}
                  disabled={savingTier !== null}
                  style={{ padding: "7px 14px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c", fontFamily: "inherit" }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => { const t = pendingTier; setPendingTier(null); void changeTier(data.dealer.dealer_id, t); }}
                  disabled={savingTier !== null}
                  style={{ padding: "7px 14px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
                >
                  Convert &amp; start billing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Downgrade-to-Free modal (PART B) — soft reason doubles as confirm ── */}
      {closeStep !== null && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}
        >
          <div style={{ background: "#fff", borderRadius: 6, width: 460, maxWidth: "94vw", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>Downgrade to Free</span>
              {closeStep !== "closing" && (
                <button onClick={() => setCloseStep(null)} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}>×</button>
              )}
            </div>
            <div style={{ padding: 20 }}>
              <p style={{ fontSize: 13, color: "#333", margin: "0 0 14px", lineHeight: 1.5 }}>
                Downgrading cancels <strong>{data.dealer.name}</strong>&apos;s subscription immediately. They keep log-in access for <strong>60 days</strong> (view only — no printing). Re-subscribe within 60 days to restore; after that the account is archived.
              </p>

              <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>
                Reason <span style={{ color: "#9aa4ad", fontWeight: 400 }}>(optional)</span>
              </label>
              <select
                value={closeReason}
                onChange={e => setCloseReason(e.target.value)}
                disabled={closeStep === "closing"}
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, marginBottom: 10, background: "#fff", fontFamily: "inherit" }}
              >
                <option value="">— select a reason —</option>
                <option value="too_expensive">Too expensive</option>
                <option value="not_enough_value">Not enough value</option>
                <option value="switching_provider">Switching to another provider</option>
                <option value="closed_dealership">Closed / sold the dealership</option>
                <option value="seasonal_pause">Pausing for the season</option>
                <option value="missing_feature">Missing a feature</option>
                <option value="other">Other</option>
              </select>

              <label style={{ display: "block", fontSize: 12, color: "#55595c", marginBottom: 4 }}>
                Anything else? <span style={{ color: "#9aa4ad", fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                value={closeDetail}
                onChange={e => setCloseDetail(e.target.value)}
                disabled={closeStep === "closing"}
                rows={3}
                placeholder="Notes about why this dealer is downgrading."
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
              />

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button
                  onClick={() => setCloseStep(null)}
                  disabled={closeStep === "closing"}
                  style={{ padding: "7px 14px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c", fontFamily: "inherit" }}
                >
                  Keep current plan
                </button>
                <button
                  onClick={() => void closeAccount(data.dealer.dealer_id)}
                  disabled={closeStep === "closing"}
                  style={{ padding: "7px 14px", background: closeStep === "closing" ? "#9aa4ad" : "#c62828", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: closeStep === "closing" ? "default" : "pointer", fontFamily: "inherit" }}
                >
                  {closeStep === "closing" ? "Downgrading…" : "Downgrade to Free"}
                </button>
              </div>
            </div>
          </div>
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
