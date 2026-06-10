# 🔴 Billing price integrity — da-billing must be the SOLE price authority

> For Claude Code. Owner: Allan. Created 2026-06-07. **Serious — real invoicing.** Spans
> **da-billing** (primary fix + remediation) and **da-platform** (stop sending prices).

## The rule (Allan)
DA Platform **NEVER sends prices** to da-billing. It sends only: **subscription type**
(`sub-manual`/`sub-auto-web`/`sub-auto-dms`), **label type + quantity**, **Color Matched Photos**
(presence), **One Time DMS Setup Charge** (presence). **da-billing alone sets prices** — fixed
pricing (Manual $100 / Auto-Web $150 / Auto-DMS $200; Color Photos $50; DMS Setup $50; labels by
matrix), with group/reseller **discounts applied in da-billing** (the customer's
`subscriptionDiscount`).

## Symptom
Dealer General's bill dropped Apr 12 ($13,675.00, inv 50323) → May 13 ($7,937.50, inv 51219).
Its recurring template's line items show **legacy prices** ("from the old system"): Auto-Web **$75**,
Auto-DMS **$125** — not the canonical $150/$200. 50% reseller discount, 214 dealer lines. Next
invoice generates **Jun 13, 2026** — so the wrong (low) price bills again in ~6 days if not fixed.

## Root cause (two real violations, both confirmed in code)
**1. da-platform SENDS prices.** Both template-builders attach `price` (looked up via
`lookupPrice`):
- `app/api/dealers/route.ts:105` — `price` on the subscription line (+ `:114` dms-setup).
- `app/api/billing/me/subscription/route.ts:144` — `price: newPrice` (+ `:174` dms-setup).
- `app/api/dealers/[id]/route.ts` name-sync rewrites lineItemDescriptions and `putTemplate`s the
  **existing products array** (carrying whatever prices are stored) on a dealer rename.

**2. da-billing HONORS caller-supplied prices** for non-label products — `src/lib/api-routes.ts`
POST `/templates` **:2259** and PUT `/templates` **:2326**:
```
// Non-labels: honor caller-supplied price, else resolve canonical.
if (typeof p.price === "number" && p.price > 0) return p;   // ← keeps whatever was sent
...
const canonical = await pricing.getPriceForProduct(p.productId);
```
So for subscriptions + fixed products, **any sent price wins** over canonical; canonical only
applies when price is omitted. (Labels are always server-priced — correct.)

**Net:** legacy per-dealer prices seeded into templates at migration (FreshBooks/Aurora fees,
e.g. 75/125) are **preserved indefinitely** — every dealer-rename `putTemplate` and every
da-billing Edit-Template save (`src/components/template-dialog.tsx` sends a `price` per line, even
requires `price > 0`) re-honors them. The platform's own sends are canonical today (`lookupPrice`),
so they aren't the source of 75/125 — the **legacy seed + the honor branch** are.

### What is NOT the cause (ruled out)
- **`PUT /pricing` "update all templates"** (`api-routes.ts:2787`) is **correct** — it sets
  subscription lines to `newPricing[productId]` (canonical 150/200), no discount baked in. This is
  the **remediation tool**, not the bug.
- **Recent commits** (`40d185a` canonical-resolution, etc.) landed **2026-05-22**, *after* both the
  Apr 12 and May 13 invoices — they didn't cause the historical drop.
- The exact Apr→May delta (price vs. membership vs. discount change at generation time) needs the
  **KV template history + the two invoices' line items** to pin precisely; not required for the
  fix. CC can confirm by reading inv 50323 vs 51219 line items + `template:18796f8c-c.updatedAt`.

## The fix
**A. da-billing — always canonicalize subscriptions + fixed products; ignore any sent price
(PRIMARY).** In POST and PUT `/templates` (`api-routes.ts` ~2246 and ~2313), replace the non-label
branch so that for `sub-*`, `color-photos`, `dms-setup` it **always** sets
`price = await pricing.getPriceForProduct(p.productId)` and **never** honors `p.price`. Keep labels
exactly as-is (server-side matrix). This makes da-billing the sole authority even if a caller
mistakenly sends a price — closing the hole permanently.

**B. da-platform — stop sending prices (principle + defense-in-depth).** Omit `price` from the
template products in `app/api/dealers/route.ts` and `app/api/billing/me/subscription/route.ts`
(drop the `lookupPrice` calls there); send only `productId`, `quantity`, `lineItemDescription`
(+ label fields for labels). In `app/api/dealers/[id]/route.ts`, **strip `price` from every product**
before the name-sync `putTemplate` so a rename can't re-persist a stale price. (Aligns with the
existing `BillingProduct.price` comment that says the platform omits it.)

**C. da-billing Edit-Template UI** (`src/components/template-dialog.tsx`) — for subscription +
fixed lines, show the canonical price **read-only** (no editable price box; drop the
"price > 0" requirement for those) so the UI can't re-submit a stale/hand-typed price. Lower
priority once (A) lands, but keeps the UI honest.

## Remediation (after A+B deploy — order matters)
1. **Read-only audit (blast radius):** script over da-billing `kv.getByPrefix("template:")` — for
   every template, flag any `sub-*`/`color-photos`/`dms-setup` line whose `price` ≠ canonical for
   its productId. Report customer count + a sample. Sizes how many groups/resellers/dealers are
   mispriced. **Do this first, read-only.**
2. **Deploy A + B** (don't remediate before the code is fixed, or legacy prices creep back).
3. **Re-canonicalize all templates:** re-save global pricing (Admin → Pricing → Save, same
   100/150/200) which runs the `PUT /pricing` mass-update (sub lines → canonical), **or** a
   one-time script that re-PUTs each template through the now-canonicalizing endpoint (also fixes
   color-photos/dms-setup). Labels untouched.
4. **Verify Dealer General:** template shows Auto-Web $150 / Auto-DMS $200 pre-discount; the 50%
   reseller discount yields the correct total; re-run the audit → 0 mispriced lines.
5. **Beat the clock:** confirm the corrected total **before the Jun 13 invoice generates**.

## Secondary (flag, don't fold in without Allan)
- **Discount auto-tier sync:** da-platform pushes `subscriptionDiscount` to da-billing
  (`x-da-auto-tier-sync`; `customers` PUT ~line 790). Allan's "what the platform may send" list
  did **not** include discount — billing arguably owns discount too. da-billing already guards
  custom/locked discounts (`97ddc96`, `discountLocked`), and Dealer General is locked at 50% so
  it's protected. Decide separately whether the platform should stop pushing discount entirely.

## Verify
- A new dealer/subscription change creates a template whose subscription price is **canonical**
  even if the caller sends a wrong price (server ignores it).
- A dealer **rename** no longer changes any price.
- Re-saving global pricing (or the remediation script) resets all templates; Dealer General →
  150/200 pre-discount; audit returns 0 mispriced.
- Corrected before the Jun 13 invoice run.
- **STOP for review before deploy** (touches live invoicing).
