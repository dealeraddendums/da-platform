# Feature — "Upgrade Now" CTA in the sidebar for non-paying dealers

> For Claude Code. Owner: Allan. Created 2026-06-02.
> Trial (and Free/Downgraded) dealers shouldn't have to hunt for billing. Add a
> prominent **yellow "Upgrade Now"** button to the left nav linking straight to the
> Billing tab. Shown only to dealers who aren't already on a paid plan.

## Deep link (confirmed)
The Billing tab is reachable at **`/profile?tab=billing`** — the profile page reads
`?tab=` and accepts `billing` (`ProfileClient` ~1986–1994), and the sidebar already
uses the same `?tab=` pattern for "Order Supplies" (`/profile?tab=labels`). So the
button just links there.

## Change
1. **`app/(dashboard)/layout.tsx`:** it already resolves the current dealer's
   profile/role (used for `hideBuilder`). Also read the dealer's `account_type` and
   compute `showUpgrade = role === 'dealer_admin' && !isPaidAccountType(account_type)`
   (reuse `isPaidAccountType` from `lib/print-eligibility.ts` — non-paid = Trial /
   Trial-Expired / Free / Downgraded). Pass `showUpgrade` into `<Sidebar />`.
2. **`components/Sidebar.tsx`:** accept `showUpgrade?: boolean`. When true, render a
   **yellow CTA at the top of the nav** (above "Dashboard") — a
   `<Link href="/profile?tab=billing&upgrade=1">` styled as a button: background `#ffa500`,
   text `#2a2b3c` (navy), bold, ~full-width with margin, small up-arrow/⚡ icon,
   label **"Upgrade Now"**. Make it visually distinct from the regular `nav-item`
   rows so it pops against the navy sidebar.

3. **`ProfileClient` BillingTab — auto-open the plan picker.** The plan list is
   gated behind the `changeOpen` toggle (the "Change Plan" ↔ "Cancel" button). When
   the URL carries **`?upgrade=1`**, initialize `changeOpen = true` so the dealer
   lands directly on the **expanded plan cards**, not the collapsed "Change Plan"
   button. Read `?upgrade=` in the same `useEffect` that reads `?tab=` (the
   hydration-safe pattern already there).

## Scope
- **`dealer_admin` only** — the only role that can actually change the plan (the
  subscription PATCH is dealer_admin/super/group). Don't show it to
  dealer_user/dealer_restricted (dead-end) or to paid dealers / group_admin /
  super_admin.

## Verify
- A Trial / Trial-Expired / Free dealer_admin → yellow "Upgrade Now" at the top of
  the sidebar → click → lands on My Profile → **Billing** tab.
- A paid dealer → no button. group_admin / super_admin / dealer_user → no button.
- Stop for review before deploy.
