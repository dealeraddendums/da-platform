# DA Platform — build queue / spec index

> Running index of the specs from the 2026-05-30/06-01 planning sessions. All spec
> docs live in `da-platform/docs/`. Every open item says "stop for review before
> deploy." Keep this updated as items ship.

## ▶️ Next session
- **🔴 URGENT — ETL config-lock ENFORCEMENT (`da-legacy-etl` half) NOT built; the freeze toggle is
  inert** (task #115; see `da-legacy-etl/docs/etl-config-lock.md` STATUS banner). The da-platform
  freeze toggle + account_purpose classifier shipped, but `da-legacy-etl` never honored `etl_locked`,
  so Job 5 (Options) re-upserts deleted products **nightly** — Mercedes Benz of Collierville (Dealer
  General) has a **duplicate "Elite Member"** that, being Required/All-Vehicles, **prints twice on
  their addendums**. Build + deploy the runner change (configDealers/printStatusDealers + Job 1/2
  skip-sets per the spec), then freeze Dealer General + re-delete the dupes. **Stopgap until then:**
  set Mercedes `migration_status='migrated'` (ETL already skips it; reversible; harmless — it's a
  new-platform dealer).
- **Fuel Type product rule — SHIPPED 2026-06-09** (`40eb01f`; `options-rule-fuel-type.md`): curated
  multiselect (Gasoline/Diesel/Hybrid/Plug-in/Electric/Flex/Hydrogen/CNG/Propane) + IN/NOT IN +
  keyword-CSV matching; Electric catches BEV/ELEC, NOT-IN [Gasoline] excludes 62k, only a 4-vehicle
  junk edge. `deploy.sh` hardened (`fbc4539`). Open follow-up: the `dealer_vehicles.fuel` 95%-garbage
  feed-mapping bug (separate, w/ Alex).
- **DA Business Intelligence tab (SuperAdmin) — Phases 1 + 2 SHIPPED 2026-06-08** (da-billing
  `c03ddbd` · da-platform `72b8419` [P1] + `b8c6d53` [P2]). `superadmin-bi-tab.md`.
  8 metrics (trials · conversions · lost-trials · acquisition source · group dealers added ·
  cancellations independent-vs-group + reasons · gross-billable trend); default = previous calendar
  month + custom range; **PDF + Excel** download; **on-demand** email. New pieces: `dealers.converted_at`
  (migration ~095 — confirm next free) + da-billing `GET /reports/gross-billable`. **Foundation
  (REQUIRED): stamp `converted_at` AND `downgraded_at` + an `account_closures` row on EVERY write
  path** — incl. admin/bulk downgrade (prod 2026-06-08: 2,107 dealers, 325 Free, **0 `downgraded_at`,
  0 closures** → churn reads 0 until this ships; the 325 are legacy baseline, ≤36 ever-billed). Exact
  SQL in the doc's appendix. ✅ Verified live: gating, cohort identity sums, gross-billable reconciles
  to da-billing Reports, admin-downgrade + self-close both write `downgraded_at` + a closure that
  surfaces in the metric, `is_test` exclusion holds, 8 internal test dealers flagged.
  **Phase 2 (PDF/Excel export + on-demand email) SHIPPED** (`b8c6d53`) — exports/email build from the
  same `buildBiReport()` as the screen (PDF == Excel == on-screen; `is_test` + test-customer revenue
  exclusions inherited); super_admin-gated, a test email to allan@ delivered with both attachments.
  Remaining follow-ups: (a)
  at-creation **account-purpose classifier (Real / Test / Sales Demo)** on super_admin
  dealer-create — root cause; QA fixtures AND ongoing sales demos must be flaggable at creation so
  they auto-exclude from BI/billing/HubSpot (today nothing flags them, so they pollute until swept);
  (b) optional da-billing-dashboard test-customer cleanup (BI revenue already auto-excludes via
  `excludeCustomerIds`); (c) ✅ Demo-Account triage — Allan confirmed all 8 are **sales demos** →
  flag `is_test=true` (Andre / Asher Enterprises / Tyler Jorgensen / CA ClearBra / Millennium Dealer
  Services / CDS Zoom / STARSHIELD / Toyota Demo accounts).
  _(Other 2026-06-07/08 specs — past-due print lock, ETL config-lock + freeze toggle, billing
  price-integrity [shipped], addendum-data sync gap — are tracked in their own docs in `docs/`,
  pending the session-close fold-in.)_
- **Platform ↔ da-billing link sync (revises old "Step 3").** `platform-billing-link-sync.md`.
  The "128 groups with no `groups.billing_customer_id`" is **not** missing customers — da-billing
  **already has** them (Dealer General = `18796f8c-c`, active), the platform link was just never
  backfilled. So this is a **sync/backfill across all groups + dealers (~95% already have a
  da-billing customer)**, NOT a mass-create — mass-creating would **duplicate**. Crux = the
  match key (da-billing **DA Client ID** ↔ platform legacy/internal id; CC resolves against live
  data). Also **guard "Create Billing Account" + the cascade lazy-create** to link an existing
  customer instead of duplicating. ⚠️ Until the guard ships, don't click Create Billing Account on
  an existing account. Read-only audit + dry-run first.
- **Confirm deploy — group_admin active-dealer scoping (Dashboard/Products)**
  (`group-admin-active-dealer-scoping.md`, #71). Specced; the template-save sibling shipped
  (`313d9fc`) — confirm the Dashboard/Products page scoping deployed too.
- **Route-audit sweep — DONE (`dcacae2`):** fixed the disclaimers gap (group_admin-as-dealer in
  the blank Builder); options, image uploads, and custom sizes were already correct/intentional.
- **group_admin authorization fixes — CONFIRMED, spec'd** (`group-admin-read-scope-and-billing.md`):
  (1) **group-scoped reads** — Allan: a group_admin may read only its own group's dealers, so add
  the group-ownership check to `options/library` **and** `corporate-products` (overrides the prior
  "intentional" note) + sweep other dealer-scoped GET routes; (2) **active-dealer billing** —
  Allan: group_admins manage a member dealer's billing while switched in, so make `billing/me*`
  honor the active dealer (same fix as template-save). Ready for CC.
- **Legal pages:** final legal-counsel review before treating as binding; **marketing DNS
  cutover** — the new `/terms` + `/privacy` are live on the app and staged on the marketing box
  (`dealeraddendums.com/terms` goes live at cutover).
- **Verify in the wild:** the scanner-proof invite holds against a real dealership Barracuda;
  group_admin-as-dealer template save (`313d9fc`).
- **Open bug to spec:** Addendum page ignores `?type=infosheet` / `?type=buyer_guide` from the
  Bulk buttons (root `CLAUDE.md` → Active Issues).
- **Operator (manual):** HubSpot dup triage + re-enable Alex's lifecycle workflows — see
  "Operator-side follow-ups" at the bottom.

## ✅ Shipped (for context)
- **PDF per-vehicle fix** — flat `{VIN}.pdf` keys + bulk per-vehicle upload + nested
  backfill. `pdf-vin-fix-deploy-task.md`. Deployed + verified.
- **HubSpot Phase 14 sync** (company/contact records). `hubspot-sync-plan.md`.
  Commit `3222757`.
- **HubSpot realtime sub/lifecycle + Downgraded + 60-day archive cron.**
  `hubspot-lifecycle-realtime-and-archive.md`. Commit `b822b86`. The
  `archive-downgraded` cron is live.
- **HubSpot dedup guard** (skip-create + alert in `lib/sync-hubspot.ts`).
  `hubspot-dedup-cleanup.md`. Commit `74c7bf7`.
- **HubSpot dedup merge cleanup — `--apply` ran on prod 2026-06-01.**
  `scripts/hubspot-dedup.mjs` shipped (commits `74c7bf7`, `328b2ac`, `8f54185`).
  **95 of 95 merges successful, 0 errors.** 92 REVIEW cases dumped to
  `~/Desktop/dedup-reviews-clickable.txt` for operator triage in HubSpot's
  Manage Duplicates UI. 61 pre-existing dup clusters (no `platformid` involved)
  remain for manual cleanup — separate from this work.
- **Subscription ⇄ account_type reconcile.**
  `subscription-account-type-reconcile.md`. Audit + reconcile scripts shipped
  (`scripts/billing-account-type-audit.mjs` + `scripts/billing-account-type-reconcile.mjs`)
  + the actual fix in commit `c15a2fc`. Diagnosis: ~78% of paying dealers
  carried legacy long-form `account_type` (`"Automatic Web"` / `"Automatic DMS"`
  / `"Manual"` ± `$price` suffix); HubSpot sync was handling them correctly,
  but `subscriptionLabel` in DealerList only matched short-form / "Monthly
  Subscription …" keys and collapsed everyone else to "Free". Fix mirrors
  `lib/hubspot.ts normalizeSubscriptionType` normalization. No bulk
  `account_type` rewrite was needed.
- **Builder background upload.** `builder-background-upload.md`. Commit `7f50336`.
- **Builder custom-size doc_type** (landscape infosheet). Commit `664eae0`.
- **MPG widget** (Part A data wiring + Part B widget). Commit `535c0a1`.
- **HubSpot manual sync tab** (super_admin only, SSE live log).
  `hubspot-manual-sync-tab.md`. Commit `158e24a`.
- **Walkthrough tweaks #1 + #2** — locked-product 🔒 tooltip + bulk "Clear
  Print History". `team-walkthrough-tweaks.md` (items 1+2). Commit `ad9368d`.
  ✅ Button-port follow-up shipped 2026-06-02 — Clear Print History now renders in
  `ManualVehicleInventory.tsx` (the dashboard + `/vehicles` component).
- **Read-only dup count** — `scripts/hubspot-dup-count.mjs` (last run: 163
  sync-created dup clusters resolved by the merge above; 61 pre-existing
  clusters still pending operator review; contacts clean).
- **Print-eligibility gate.** `print-eligibility-free-expired.md`. Commit `b8c9a82`.
  `lib/print-eligibility.ts` (`canPrint` / `isOverAllowance` / `enforceCanPrint`;
  caps = 30 days OR 30 lifetime prints since `created_at`). 403 enforced in all
  four print routes (`pdf/generate`, `pdf/bulk`, `print/bulk`, `print/[vehicleId]`);
  Print Now / Info Sheet / Buyer Guide buttons render disabled + tooltip in the
  inventory UI. `super_admin` bypasses. "Free Expired" folded into Downgraded —
  no new HubSpot stage.
- **Dealer self-close / downgrade-to-Free.** `dealer-self-close-account.md`.
  Commit `bfbda56`. `POST /api/billing/me/close` — $0 balance re-checked
  server-side (409 `balance_due` with amount + count) → `deleteTemplate` stops
  recurring billing immediately (no `archiveCustomer`) → `account_type='Free'` +
  `downgraded_at`, stays `active` → `account_closures` row → HubSpot Downgraded
  via `fireDealerReliable`. Migration `085_account_closures.sql`. "Free — $0/mo"
  option added to the BillingTab plan picker. Re-open = re-subscribe (existing
  `/api/billing/me/subscription` PATCH); +60-day archive = existing
  `archive-downgraded` cron. No new cron.
- **Walkthrough tweaks #3 + #4.** `team-walkthrough-tweaks.md` (items 3+4).
  Commit `c47528a`. (3) Dealer-profile header buttons readable on blue —
  HubSpotPill white + `#ff7a59`, Deactivate white + `#ff5252`. (4) Configure
  Product toggles standardized to blue=on / white=off across OptionsLibrary +
  CorporateProductModal; multi-select on Type preserved.

### Shipped 2026-06-02 (session — all verified by Claude Code; commit refs TBD)
- **Clear Print History — dashboard port.** Ported the button +
  `clearPrintHistoryForSelection` into `ManualVehicleInventory.tsx` (the dashboard +
  `/vehicles` component). `team-walkthrough-tweaks.md` #2.
- **Graphical printer-nudge (arrow pad + live preview).** `printer-nudge-graphical.md`.
  `SettingsForm.tsx` — arrow steppers + live page preview; `nudge_*` data/save unchanged.
- **Order history — "Ordered By" name.** `order-history-ordered-by.md`. Migration
  `086` (`label_orders.ordered_by_name`); POST persists it, GET selects it, new column.
- **Tire loader for the multi-print overlay.** `multi-print-tire-loader.md`.
  `PdfBuildingOverlay.tsx` → `<img src="/datire_loader.svg">` (asset in `public/`,
  self-animating SMIL; corrected-shadow version).
- **Group-ghost scoping — Dashboard + Dealers.** `group-ghost-dashboard-dealers-scoping.md`.
  `dashboard/page.tsx` + `dealers/page.tsx` route the group ghost (`ghostCtx.group_id`)
  into the existing group_admin branches; ghost-as-group now shows the group's data.
- **Safe rich-text + image product names (+ sanitized descriptions).** `product-image-names.md`.
  `alt` on image insert; sanitized `<RichName>` renderer (`lib/product-name.tsx`;
  allowlist + img→thumbnail+label) at every name site; descriptions routed through the
  same sanitizer (new HTML-sanitizer dep).
- **Custom Size available to dealers.** `builder-custom-size-for-dealers.md`.
  `builder/page.tsx` `canAddCustomSize` now includes `dealer_admin` (API already allowed it).

### Shipped 2026-06-04
- **Lock DA team accounts to super_admin.** Migration `088_lock_team_super_admin.sql`.
  Root cause: the daily DA Legacy ETL (Job 3 — Profiles) maps Aurora `USER_TYPE` →
  `role` and upserts on email, silently downgrading the team's own accounts every
  run (found 4 of 5 sitting at `dealer_user`). Fix is a writer-agnostic
  `BEFORE INSERT OR UPDATE` trigger on `public.profiles`
  (`enforce_team_super_admin()`) that pins `allan/alex/claire/marlena/carol
  @dealeraddendums.com` to `role='super_admin', active=true` regardless of caller
  (ETL, `import-users.ts`, or any API upsert). One-time backfill in the same
  migration restored the downgraded accounts. Applied via Supabase SQL editor
  (no `psql`/exec-RPC/CLI link on this project); verified live by a deliberate
  downgrade PATCH that bounced back to `super_admin`. **To add/remove a team
  member: edit the email array in the function via a new migration.**

### Shipped 2026-06-05 (session — verified by Claude Code; commits 8e9a93b · ca65353 · 3354daa, bill-to + member-table refs TBD)
- **ETL Profiles job → no-op + mapRole fix + demotion audit.** `da-legacy-etl`
  `src/jobs/profiles.ts`, commit `8e9a93b`. Root cause: the daily Profiles job upserted
  `role` by email, and `mapRole` only recognized Aurora `GroupAdmin` — `RootAdmin` /
  `DealerAdmin` / `DealerAdminRestricted` all collapsed to `dealer_user`, silently demoting
  promoted users (Robert: manual group_admin → reset). Fix: job is now a **no-op** (Supabase
  is source of truth for profiles; it can't create profiles anyway — `profiles.id` = auth
  UUID, ETL must not create auth users). `mapRole` also corrected (Root→super_admin,
  Dealer→dealer_admin, DealerAdminRestricted→dealer_restricted) but **inert** while the job
  is a no-op. Audit: ~2,174 profiles sat above the broken map, but the app reads
  `profiles.role` **by auth UUID** so demotions only bit single-row users — **only Robert
  confirmed**; the 4 team super_admins were already protected by the migration-088 trigger.
  `da-legacy-etl/docs/profiles-no-overwrite.md`.
- **Group bill-to backfill (one-time).** `group-billing-backfill.md`. The app reads the
  migration-067 columns `dealers.subscription_billed_to` / `labels_billed_to` (default
  `'dealer'`); 067 never backfilled them and the ETL syncs no bill-to → every group dealer
  showed Dealer/Dealer. Backfilled **856 group dealers** from Aurora
  `dealer_dim.SUB_BILLING_TO` (subscription) / `BILLING_TO` (labels), `group_id IS NOT NULL`
  only (standalone dealers untouched). **Not** added to the ETL (one-time; new platform is
  source of truth). **Step 3 (group da-billing customers) DEFERRED — see Next session.**
- **Group member table — sort + search + layout.** `group-member-table-ux.md`. Member
  Dealers list is sortable + searchable by Name / Dealer ID / Inventory Dealer ID
  (client-side); the Users/Billing/Corporate Products/Disclaimers/Templates tabs now render
  **above** the (long) member list.
- **User-invite feedback + Pending Invitations.** `user-invite-feedback.md`. Group (+ dealer)
  Users tabs show an "Invitation sent" toast and a **Pending Invitations** section
  (resend/revoke) so an invite is no longer invisible until accepted.
- **"Last sign in: Never" fix.** `invite-auth-and-last-signin.md` (Part B). `auth` schema
  isn't exposed to PostgREST, so `admin.schema("auth").from("users")` returned nothing and
  every row fell back to "Never." New `lib/last-sign-in.ts` (`lastSignInByEmail()`, paginates
  the GoTrue admin API, 60s cache); group Users + all 3 branches of `/api/users` resolve
  last-sign-in **by email**.
- **Invite auth model + scanner-proof acceptance.** `invite-auth-and-last-signin.md` (Part A)
  + `scanner-proof-invite.md`. Commits `ca65353` (auth model + last-sign-in) and `3354daa`
  (sign-in + group-name badge fix). Migration **089** (`setup_code_hash`,
  `setup_code_expires_at` on `invitations`; applied via Supabase SQL editor). New
  `lib/invite-code.ts` (8-digit code, SHA-256, constant-time verify) + `lib/invite-email.ts`
  (email **leads with the code**, link is inert). `/api/invite/accept` rewritten to consume
  the invitation **only on a human action** (code-verify or password-submit) — never on
  link-load or code-send — sets `app_metadata.role`, idempotent user resolution;
  `/api/invite/resend` (non-consuming). `/signup?invite=` is a state machine: choose →
  code | password → passkey (skippable) → dashboard. Closes the recurring **Barracuda
  link-scanner** consumption (empty-UA HEAD+GET on the invite URL confirmed in access logs).
  Dealer choice: code **or** password; passkey offered with a plain-English explainer, never
  required.

### Shipped 2026-06-05 (cont. — commits `9b2d052` · `ec3f379` · `313d9fc` + legal `54922b6`/`45282be`/`77da13b`)
- **Dealer/group-scoped Builder images.** `builder-scoped-images.md`. Commit `9b2d052`,
  **migration 090** (`scope`/`group_id`/`dealer_id` on `image_library`). Three tiers in the
  "Choose Background" picker — **Platform** (all) / **{Group} Library** (group_admin-managed,
  all member dealers) / **My Images** (dealer-private); scope-aware Upload for dealer_admin +
  group_admin; per-image delete limited to the caller's scope; scoped S3 key prefixes; scope
  enforced on both the API (`getJwtClaims`) and RLS. New Group Image Library panel on the group
  page.
- **Legal pages — Terms of Use + Privacy Policy.** Canonical `docs/legal/*.md` +
  `legal-pages-styling.md`. Rewritten for the current platform (Trial/Paid/Free lifecycle,
  passwordless, "we don't access customer/sale/card data," named sub-processors). Public
  `/terms` + `/privacy` on **DA Platform** (`54922b6`) and the **marketing site**
  (`45282be`/`77da13b`), rendered from byte-identical markdown. Branded: real login logo,
  login-style gradient, white document sheet, **Download PDF** (print-to-PDF), **← Back to sign
  in**. Entity **DealerAddendums LLC**, governing law **Delaware**, contact
  **support@dealeraddendums.com** only. ⚠️ Marketing copies must be re-synced from canonical on
  any edit. Pending: legal-counsel review + marketing DNS cutover.
- **Builder Position & Size spinner fix.** Commit `ec3f379`. X/Y/W/H inputs now `step={SNAP}`
  (4px grid) + `min` — the spinner arrows move the widget by one grid cell (a default +1 step
  previously snapped straight back via `snapV`).
- **group_admin template-save (active-dealer).** `group-admin-template-save.md`. Commit
  `313d9fc`. `resolveDealerId` (`/api/templates`) + `/api/settings` now honor a group_admin's
  **active dealer** (`claims.dealer_id`, group-verified) instead of 400ing on a missing
  `?dealer_id`; the Builder save also passes the param. `PATCH /api/templates/[id]` already
  authorized via `fetchAndAuthorize` (left unchanged). A group_admin switched into a member
  dealer can now Save a dealer template + set its default.

## ✅ Queue clear (2026-06-05)

All planning-session specs through 2026-06-05 are shipped — see **Shipped** above. Open items
live under **Next session**: Step 3 (group da-billing customers, deferred), confirm the
Dashboard/Products active-dealer scoping deploy, the Builder write-path route-audit sweep, and
the legal-counsel review + marketing DNS cutover. New items get appended here as Allan sends them.

## Key cross-dependencies (resolved)
- Shared "over-allowance" predicate (30 days OR 30 lifetime prints, since
  account creation) now lives in `lib/print-eligibility.ts` (`isOverAllowance`)
  and is imported by both the print gate (`canPrint`) and the HubSpot lifecycle
  derivation in `lib/sync-hubspot.ts` — the two never disagree about who's expired.

## Operator-side follow-ups (not on the build queue, just tracked)
- Manual triage of the 92 HubSpot REVIEW cases (file at
  `~/Desktop/dedup-reviews-clickable.txt`) in HubSpot's Manage Duplicates UI.
- 61 pre-existing duplicate Company clusters (no `platformid` involved —
  predate Phase 14, separate manual pass).
- Re-enable Alex's lifecycle workflows in HubSpot now that the dedup
  `--apply` is complete.
