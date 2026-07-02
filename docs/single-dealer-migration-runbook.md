# Single-Dealer Migration Runbook (Legacy 4.0 → DA Platform V5.0)

> The per-dealer SOP for self-serve migration. Each operator works ~25 dealers toward the 100/week goal.
> Driven from the **Migration Readiness console** (Admin → Migration). Billing-sensitive:
> `MIGRATION_AUTO_ACTIVATE` is **OFF** (review-queue), so billing is activated manually at Step 7 until the
> first waves are proven.

## Before you start
- Convert the dealer to **paying** on legacy / FreshBooks.
- Run the legacy ETL — `npm run run-now` on the da-legacy-etl box — to sync the dealer (profile, users,
  settings, options, vehicles, logo) into DA Platform.
- **Dry run tip:** set the dealer's contact email to one *you* control, so the invite code comes to you and
  you complete the flow yourself (no need to involve the real dealer for a test).

## Steps
1. **Verify the sync** — DA Platform → Dealers → search the dealer. Confirm it exists; profile, users,
   options, vehicles, logo present; Account Purpose = **Real**; `migration_status` not already migrated.
   (Missing dealer_settings / logo are *warnings*, not blockers — the migration fills defaults.)
2. **Stage billing (da-billing)** — the ETL does **not** set up billing. Ensure the dealer has a customer +
   a recurring **template** for the right plan (Manual / Auto-Web / Auto-DMS), **`active = false`**, and
   **`nextInvoiceDate` = next cycle (a future date)**. That future date is the no-double-bill guard. This is
   the "billing staged" gate.
3. **Confirm the template** — open the dealer's addendum template in the Builder (default/group template +
   their synced options), eyeball it, then flip **template-confirmed** in the console.
4. **Check readiness** (Admin → Migration) — **Billing ✓ · Template ✓ · Eligible ✓ → Ready = Y.**
5. **Send the invite** — select the dealer → Send wave → **preview** → confirm. The recipient gets the
   scanner-proof **code** + inert `/migrate` link. `migration_status → invited`.
6. **Run the `/migrate` flow** (as the recipient) — enter the code → confirm dealership → set up the 5.0
   login (passkey/password) → review plan & billing → **Confirm**. → `migrated`, `account_type → Paid`,
   HubSpot synced, FreshBooks-stop alert fires, invite consumed. **Billing is not activated yet**
   (auto-activate off — by design).
7. **Activate billing** (operator checkpoint) — console "**Migrated · billing pending**" → **Activate
   billing**. Flips the da-billing template active (future date intact, **prices untouched**).
8. **Verify** — `migration_status = migrated`; `account_type` = correct Paid tier; da-billing template
   **active with a future `nextInvoiceDate`** (no immediate invoice); HubSpot lifecycle + contacts updated;
   the 5.0 login works; addendum template + options present; **print one addendum**; legacy account still
   live and untouched.
9. **Stop FreshBooks (manual, careful)** — stop the recurring profile in FreshBooks. **Never run a dry-run
   then a live run** — the OAuth token rotates and the live run will fail. Existing FreshBooks invoices stay
   due.

## Rollback (if anything's wrong)
Console rollback (or `POST /api/migration/rollback`) → `migration_status` back to invited + template
`active = false`. **Prices never touched.** Clean revert; re-runnable.

## Gotchas
- **Step 2 (stage billing)** and **Step 7 (activate billing)** are the two manual, easy-to-miss steps while
  `MIGRATION_AUTO_ACTIVATE` is off.
- Once a few waves are proven, set `MIGRATION_AUTO_ACTIVATE=1` (da-platform `.env.production`) to
  auto-activate billing on Confirm — that removes Step 7.
- White-glove groups (**Dealer General, Avia, Ourisman, Lithia**) are **not** self-serve — migrate by hand.
