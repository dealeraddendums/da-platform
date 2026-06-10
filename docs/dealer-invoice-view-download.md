# Dealer / Group invoice view + download (Billing tab)

> For Claude Code. Owner: Allan. Created 2026-06-08. Dealers and groups can **view and download**
> their current and past invoices, not just pay them. **Read-only / additive — no migration, no
> writes.** da-platform only (da-billing's invoice endpoint already exists; da-pdf-service already
> deployed).

## What's already there
- **da-billing** generates the invoice document (`generateInvoicePdfHtml`) and serves it at
  **`GET /invoices/:id/pdf`** — but it returns **HTML** (not a PDF binary), and it's **public /
  no-auth ("for sharing")**. So: a render exists; we just don't expose it to dealers, and "download"
  needs a real PDF.
- **da-platform** Billing tabs `DealerBillingTab.tsx` + `GroupBillingTab.tsx` already render
  **Outstanding** (with a Pay link) and a collapsed **Payment History** (paid) via a shared
  `InvoiceTable`, fed by `listInvoices(customerId)` through the existing billing routes
  (`/api/billing/me`, `/api/billing/dealers/[dealerId]`, `/api/billing/groups/[groupId]`).
  Today: outstanding rows have **Pay** only; history rows have **no actions**.

## Build
### 1. Scoped proxy (never hand the browser da-billing's public URL)
Shared helper `streamInvoice(customerId, invoiceId, { download })`:
- **Ownership check:** confirm `invoiceId` is in `listInvoices(customerId)` for the resolved
  customer → **403** otherwise. (`listInvoices` is the gate: "if you can see the row, you can get
  the doc.") This is what makes the public da-billing endpoint safe to use.
- Fetch da-billing `GET /invoices/:id/pdf` (the invoice **HTML**).
- `download` → send that HTML to **da-pdf-service** (HTML→PDF via `lib/pdf-service-client.ts` + the
  existing `/api/pdf/status` proxy/poll — invoice is one page, fast) → stream `application/pdf`,
  `Content-Disposition: attachment; filename="invoice-{number}.pdf"`.
- else (**view**) → return the HTML (opens in a new tab).

### 2. Routes — one per existing billing context, each REUSING its sibling's auth + customer resolution
- `GET /api/billing/me/invoices/[invoiceId]/pdf[?download=1]` — dealer self **and** group_admin
  switched into a member dealer (same active-dealer / responsible-payer resolution as `billing/me`).
- `GET /api/billing/dealers/[dealerId]/invoices/[invoiceId]/pdf[?download=1]` — super_admin / dealer
  detail (mirror `/api/billing/dealers/[dealerId]` auth).
- `GET /api/billing/groups/[groupId]/invoices/[invoiceId]/pdf[?download=1]` — group (mirror
  `/api/billing/groups/[groupId]` auth). **This is the screenshot's case** (group_admin viewing the
  group's billing).

Reusing each sibling's resolution means authorization is identical to what already gates the
invoice **list**, so view/download can't be broader than what the user already sees.

### 3. UI — `DealerBillingTab.tsx` + `GroupBillingTab.tsx` (`InvoiceTable`)
- Add **View** + **Download** to **every** row — the `"outstanding"` variant (next to the existing
  **Pay**) **and** the `"history"` variant (paid rows, which have no actions today).
  - **View** → open the invoice in a new tab (proxy, HTML).
  - **Download** → proxy with `?download=1` (real PDF).
- Build the action URL from the route that matches the tab's context (me / dealers / groups) +
  `inv.id`. Keep Payment History collapsed-by-default; rows are now actionable. Mirror both tabs
  (they share layout — the Dealer tab header note already says it mirrors the Group tab).

## Decision (locked 2026-06-08, Allan)
**View = the da-billing invoice HTML; Download = a real PDF via da-pdf-service.** Nicer UX (clean
filename, no browser print dialog) and reuses the platform's HTML→PDF microservice. (The lighter
print-to-PDF fallback was considered and not chosen.)

## Notes / scope
- Inherits the existing billing authorization: **dealer = own invoices**, **group_admin = the
  group's + a switched-in dealer's**, **super_admin = any**. No new scope.
- da-billing's `/invoices/:id/pdf` stays public/no-auth (unchanged) — fine, because the dealer-facing
  path goes through the authenticated proxy + ownership check; the browser never sees that URL or the
  da-pdf-service private IP. (The public endpoint is low-risk anyway — invoice ids are UUIDs and the
  app only ever hands a customer their own ids.)
- No da-billing change required. No migration. No writes.

## Verify
- A **dealer** (own), a **group_admin** (group billing + a member dealer they're switched into), and
  **super_admin** (any dealer) can each **View** and **Download** their **current and past** invoices.
- A dealer requesting an `invoiceId` that isn't theirs → **403** (ownership check).
- Download produces a real `.pdf` that opens cleanly; filename carries the invoice number; the
  numbers match the on-screen row and the da-billing invoice.
- View opens the invoice document in a new tab.
- STOP for review before deploy.
