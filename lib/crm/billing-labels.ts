// Billing states a paying dealer shows (lib/crm/billing-status.ts reads them
// from DA-Billing). Kept apart so client components can import the labels
// without pulling in the DA-Billing client.
export type BillingState = "current" | "past_due" | "suspended";
export const BILLING_STATE_LABEL: Record<BillingState, string> = { current: "Current", past_due: "Past Due", suspended: "Suspended" };
