// Billing states DA-CRM shows (lib/crm/billing-status.ts reads them from DA-Billing). Kept apart so
// client components can import the labels without pulling in the DA-Billing client.
// none = no DA-Billing customer linked (never treated as past due).
export type BillingState = "current" | "past_due" | "suspended" | "archived" | "none";
export const BILLING_STATE_LABEL: Record<BillingState, string> = {
  current: "Current", past_due: "Past Due", suspended: "Suspended", archived: "Archived", none: "No billing record",
};
