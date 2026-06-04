# DA Platform — build queue / spec index

> Running index of the specs from the 2026-05-30/06-01 planning sessions. All spec
> docs live in `da-platform/docs/`. Every open item says "stop for review before
> deploy." Keep this updated as items ship.

## ▶️ Next session (2026-06-03)
- **Backfill** the seven 2026-06-02 commit refs (in the Shipped block below + in `CLAUDE-da-platform.md`) once CC reports them.
- **Verify during team testing:** `alt` actually written on new image inserts · red-M span / logo still renders on the printed PDF · order-history names on the 2 existing rows · ghost-as-group **Live Activity feed** limited to the group.
- **Open bug to spec:** Addendum page ignores `?type=infosheet` / `?type=buyer_guide` from the Bulk buttons (root `CLAUDE.md` → Active Issues).
- **Operator (manual):** HubSpot dup triage + re-enable Alex's lifecycle workflows — see "Operator-side follow-ups" at the bottom.

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

## ✅ Queue clear (2026-06-02)

All planning-session specs (2026-05-30 / 06-01 / 06-02) are shipped — see **Shipped**
above. New items get appended here as Allan sends them.

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
