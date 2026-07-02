# Admin Dealer Billing — Subscription Parity — CC Prompt

> Ready-to-hand-to-Claude-Code prompt. Authored 2026-06-17.
> Make the admin Dealer -> Billing tab show the same Current Subscription + Change Plan
> options as the dealer's own My Profile -> Billing. Reuses the existing super_admin-aware
> PATCH (no new write path); only mirrors the UI + a small GET extension.

---

TASK: Make the admin Dealer -> Billing tab (components/DealerBillingTab.tsx, reached at
Dealers -> [dealer] -> Billing) show the SAME subscription options as the dealer's own
My Profile -> Billing tab: a "Current Subscription" display + a "Change Plan" tier picker
(all tiers with da-billing prices), in addition to the existing invoice sections. Today the
admin tab only offers "Create Billing Account" + invoices, with no plan visibility/control.

The backend already supports this for super_admin — REUSE it, do not build a parallel write path:
- PATCH /api/billing/me/subscription already accepts a super_admin (and in-group group_admin)
  acting on another dealer via ?dealer_id=<TEXT dealer_id>, body { tier: <productKey> }. It
  sends NO price (da-billing is the sole price authority), auto-provisions/links the da-billing
  customer + template if none exists, handles trial->paid conversion (account_type + HubSpot +
  marketing webhook), the DMS setup charge, orphan-template release, and rollback. Do NOT
  reimplement any of that — call this endpoint.
- The dealer-side UI to MIRROR is in app/(dashboard)/profile/ProfileClient.tsx: the
  "Current Subscription" + "Change Plan" block (~lines 1571-1650), SUBSCRIPTION_TIERS, and
  changeTier() (~1496) which PATCHes /api/billing/me/subscription with { tier: productKey }.

STEP 1 — extend the admin GET so the tab has the data:
  In app/api/billing/dealers/[dealerId]/route.ts (dealer_billed scenario), also return:
    - pricing: getPricing() (the full tier list — same call /api/billing/me uses), and
    - subscription: derived from the customer's template first product
      ({ productId, name, price, nextInvoiceDate }) or null when no template.
  Return pricing even when there's no customer yet (so the picker can show tiers); subscription
  stays null. Leave the group_billed scenario unchanged.

STEP 2 — render Current Subscription + Change Plan in DealerBillingTab.tsx:
  Mirror ProfileClient's block. Show it for canManageBilling (super_admin / in-group group_admin /
  dealer_admin) — the same gate already in the file. On a tier click, PATCH
  /api/billing/me/subscription?dealer_id=<data.dealer.dealer_id> with { tier: productKey }.
  IMPORTANT: use the dealer's TEXT dealer_id (data.dealer.dealer_id) for the ?dealer_id= param,
  NOT the route UUID. On success, refresh() and toast like the dealer side ("Plan updated to X.
  Takes effect on the next invoice.").

STEP 3 — preserve duplicate-safety on first setup:
  Keep the existing "Create Billing Account" + 409 possible_existing_customer candidate-link flow
  (it has fuzzy duplicate detection the PATCH lacks). When no customer exists, the plan picker is
  the primary "set up billing" path (picking a tier provisions via the PATCH, which link-don't-
  duplicates on billing_id) — but keep the candidate-link path reachable so a fuzzy duplicate can
  still be linked instead of creating a dup. Don't remove that protection.

BEHAVIOR NOTE (intended): picking a plan here is a LIVE action identical to the dealer doing it —
for a Trial dealer it converts them to paid (account_type flip + HubSpot Trial->Customer +
marketing webhook). This is parity with the dealer view, NOT a draft/stage. (Migration "stage a
paused template with a future nextInvoiceDate" remains a separate da-billing operation.)

VERIFY BEFORE DEPLOY:
- No price is ever sent to da-billing (tier/productKey only; prices come from getPricing).
- A dealer with no customer: picker shows all tiers; picking one provisions customer + template
  and sets the plan; a fuzzy duplicate still surfaces the link-candidate path.
- A dealer with an active template: Current Subscription shows the live plan; Change Plan swaps it
  via the existing PATCH; invoices still render.
- group-billed dealer: unchanged (read-only group summary, no Change Plan).
- The ?dealer_id= param uses the TEXT dealer_id, not the UUID.
- STOP and show me the tab (no-customer + has-customer states) + the diff before deploying
  (billing-sensitive).
