# Phase 13 — Dealer Self-Serve Migration (4.0 → V5.0)

> Owner: Allan. Created 2026-06-12. Automates the manual per-dealer migration (see
> `dealer-migration-checklist.md`) into a guided, dealer-driven flow so you stop hand-migrating the
> ~1,600 tail. Multi-step build; **STOP for review per piece before deploy.** Billing-sensitive.

## Decisions locked (Allan, 2026-06-12)
- **Scope:** existing **4.0 dealers self-migrate** (net-new signup stays the marketing path).
- **Eligible:** **single-rooftop + simple groups.** Complex setups and **service-provider groups**
  (e.g. Dealer General) stay **white-glove** (operator-driven).
- **Trigger:** **emailed migration invite**, batched, operator-controlled cadence (no-preference → chosen
  for rollout control; an in-4.0-app CTA can be added later).
- **Billing unwind:** **stop FUTURE FreshBooks recurring**; **existing FreshBooks invoices stay due**
  (collected via FreshBooks — not voided); **da-billing bills forward from the NEXT cycle.** The template's
  `nextInvoiceDate` must be set to the next period so the **cutover month is not double-billed**.

## Dealer flow — `/migrate`
1. **Invite:** operator selects a batch of eligible dealers → system emails each a **scanner-proof OTP
   migration invite** (reuses `lib/invite-code.ts` + migration 089). 
2. **Dealer enters the code →** guided steps:
   - a. **Confirm your dealership** — show the ETL-pre-staged data (name, address, users, logo, inventory
     count) to confirm/correct.
   - b. **Set up your 5.0 login** — passkey or password (no 4.0 password carried over).
   - c. **Review plan + billing** — show plan/price; state plainly: future billing runs through da-billing,
     and any **existing FreshBooks balance stays due and is paid via FreshBooks** (transparency).
   - d. **Confirm.**
3. **System actions on confirm:**
   - `migration_status = 'migrated'` (ETL stops touching them; 5.0 = source of truth).
   - da-billing: `template.active = true`, **`nextInvoiceDate` = next cycle** (no double-bill).
   - FreshBooks: **stop the recurring profile** (operator-queued initially — OAuth token-rotation risk;
     existing invoices left **due**).
   - `account_type` → correct **Paid** tier; HubSpot lifecycle stage + the dealer's **user contacts** sync.

## Eligibility gate (auto, before invite/allow)
Single-rooftop **or** simple group (define "simple") · ETL data present + complete · **not** a
service-provider group · not flagged complex. Ineligible → routed to white-glove, not self-serve.

## QC / safety (billing's involved)
- **Review-queue for the first batches** (you/Marlena confirm before da-billing activates), then ramp to
  auto once proven. Every self-migration **logged + alerted**; easy **rollback** (`migration_status` back,
  `template.active=false`).
- **No double-bill** — the `nextInvoiceDate` rule is the guardrail.
- **FreshBooks token rotation** — the recurring-stop stays manual/careful until proven.

## Build phases
- **13a** — the `/migrate` guided flow + OTP invite + system actions (single-rooftop); FreshBooks stop =
  operator-queued.
- **13b** — batch-invite **operator tool** (filter eligible dealers, send invites, track status).
- **13c** — **simple-group** support.
- **13d** — (optional) careful FreshBooks **auto-termination**.

## Decisions — RESOLVED (2026-06-12)
1. **Eligibility = single-rooftop + all groups EXCEPT the named complex ones.** White-glove (manual) only
   the four complex groups: **Dealer General, Avia, Ourisman, Lithia.** Everything else — single stores +
   all other groups — is self-serve eligible. Implement as an explicit **white-glove exclusion list**, not
   a fuzzy "simple group" rule.
2. **QC gate:** review-queue the first batches, then ramp to auto once proven (default; Allan can change).
3. **Billing on migrate = activate, don't invoice.** Every da-billing template already carries its
   recurring **`nextInvoiceDate`**, so migration just sets `template.active = true` — **no invoice is
   issued on migration**; the cron issues the first da-billing invoice on the template's pre-set date.
   ⚠️ **Safeguard:** confirm that `nextInvoiceDate` is **in the future** at activation — a stale *past*
   date (set during migration-prep) would make the next cron run fire an immediate catch-up invoice.
   Verify/forward it to the dealer's actual next recurring date as part of activation.

## 13b — Batch-invite operator tool (detailed) — Allan's onboarding-throughput ask (2026-06-15)

> The team (Allan/Alex/Claire/Marlena = 4) fears a flood (e.g. 300 dealers/day). Plan: run controlled
> **waves of ~100/week**, and **only invite a dealer once billing + templates are confirmed.** This tool
> operationalizes exactly that — a super_admin console to see readiness, select a wave, send invites, track
> status. Inviting itself is low-risk: it changes NOTHING on the dealer's billing — the da-billing
> activation + FreshBooks stop happen on the dealer's own confirm in `/migrate` (13a).

**Readiness gate — HARD vs WARNING (softened 2026-06-16; the strict all-green gate passed only 92/2,104).**
**HARD gates — all must be green for `Ready` (these actually block a safe migration):**
- **Billing template staged** — the pre-set da-billing template exists, paused (`active=false`), with a
  **future** `nextInvoiceDate` (the no-double-bill guardrail). Group-billed → resolve to the group's customer.
- **Template confirmed** — operator-set flag; per the template decision that's the new default/group
  template (optionally legacy-config-seeded), not a per-dealer build.
- **Eligible** — not on the white-glove exclusion list (Dealer General, Avia, Ourisman, Lithia), not
  flagged complex.

**WARNINGS — shown but do NOT block `Ready` (the migration handles them):**
- **dealer_settings / logo** — the migration creates a default `dealer_settings` record (procedure Step 5)
  and a logo is optional/addable later, so a missing one is informational.
- **Inventory (vehicles/options)** — assumed from the nightly ETL; flag zero-inventory dealers, don't block.

> **The real ceiling is `billing-template-staged`** — only ~1,130 of 1,860 eligible dealers have a staged
> template, so ~730 need one staged before they can go Ready. **Staging billing templates is the actual
> prep bottleneck for the waves** — size the 100/week cadence around that, not templates or ETL.

**View:** name · group · ETL ✓/✗ · billing-template ✓/✗ · template-confirmed ✓/✗ · **Ready?** · invite
status (not-invited / invited {date} / accepted / migrated / failed-or-stalled). Filters: ready-only,
group, state, search.

**Wave action:** select up to the weekly cap (default 100) of **Ready** dealers → "Send migration invites"
→ fires 13a's scanner-proof OTP migration invite to each → logs the wave. Block not-ready dealers; warn if
over the cap.

**Status tracking:** per-dealer lifecycle invited→accepted→migrated; stalled detection (invited but not
accepted after N days → resend/nudge); a wave summary (sent / accepted / completed / pending).

**Safety:** review-queue the first waves (confirm before send); every invite + migration logged; rollback
= `migration_status` back + `template.active=false`.

**Prereqs:** 13a (`/migrate`) shipped; the "template confirmed" gate depends on the Q1 template decision.

**Build order within 13b:** (1) the eligible-dealer list + readiness computation (READ-ONLY — proves the
gate, buildable now); (2) wave-send + invite + logging (needs 13a); (3) status/stalled tracking + resend.

## Template migration — RESOLVED (2026-06-16): no layout converter; default + synced options

Read-only Aurora investigation (`legacy-template-investigation-2026-06-16.md`): legacy `template_builder`
is **fixed-slot config (case d), not a coordinate layout** — vertically-stacked full-width rows with a
single Y-offset per block (no X / width / per-element height), plus content/config (show/hide toggles,
labels, fonts, colors, logo, width/layout presets). Positions barely customized (`TOTAL_POSITION=600` for
~62% of rows). **No 2-D layout to map → a converter isn't feasible or worthwhile** (and new positions are
ground-truthed by Allan anyway). No infosheet exists in legacy; "Combo layout" = the Combo Addendum
(rich-HTML in `COMBO_*`).

**Decision:** migrated dealers take the **new default (or group) builder template + their already-synced
options** (ETL Job 5 → `vehicle_options`). So the 13b **"template-confirmed" gate is LIGHT** — apply the
default/group template and eyeball it, NOT a per-dealer build or map. Good news for the 100/week throughput:
templates are not the bottleneck.

**Also corrected:** `dealer_dim.TEMPLATE_ID` does NOT point at legacy `template_builder` — its 735 non-empty
values are already **new-platform `template:<uuid>` refs**. Legacy `template_builder` keys on `DEALER_ID`.

**Optional content-seed (separate, content-only — NOT layout):** a few legacy config fields could pre-fill
a migrated dealer's new template so it feels familiar — their custom labels (e.g. exact "Dealer Asking
Price:" wording), show/hide choices, address, and the standard "NOT AN AUTHORIZED FACTORY STICKER"
disclaimer. Reduces "this isn't mine" friction + support load during onboarding. Assess separately if wanted.

## 13a — SHIPPED end-to-end (2026-06-16)

OTP invite (13a.1) → guided `/migrate` flow (13a.2) → **confirm + system actions + rollback (13a.3)**. On
the dealer's Confirm (`POST /api/migrate/confirm`): create the 5.0 login + profile + HubSpot contact;
apply contact corrections; `migration_status='migrated'`; `account_type` → correct Paid tier +
`converted_at`; **da-billing activate** via new `POST /templates/:id/set-status` (active + future
`nextInvoiceDate` ONLY — never prices; group-billed → the group's customer); HubSpot lifecycle +
marketing conversion webhook; **FreshBooks recurring-stop = operator-queued via Mandrill alert** (never
auto-run — token rotation); invite consumed. **Rollback:** `POST /api/migration/rollback` (super_admin) →
`migration_status` back to invited + template `active=false`; prices never touched.

**⚠️ Posture — `MIGRATION_AUTO_ACTIVATE` is OFF by default (review-queue).** On Confirm the dealer migrates
but **billing activation WAITS for an operator** (an alert fires). Flip to `1` in da-platform
`.env.production` only after the first batches are proven. While OFF, a migrated dealer is **un-billed
until an operator activates** — so the operator activate-billing action below is required for the
review-queue to actually close.

**Folded into 13b step 2 (so the review-queue + tracking work end-to-end):**
- **Operator "activate billing" action** — a "migrated · billing pending" view + one-click activate
  (calls `set-status`), so AUTO_ACTIVATE-off dealers don't sit un-billed.
- **Queryable `migration_log`** — there is **no `admin_audit` table** in this project (the existing
  dealer/group DELETE audit inserts silently no-op for the same reason), so per-migration logging is
  currently only a Mandrill alert + app-log line. Add `migration_log` (who/when/billing-activated/by-whom).
  Separate cleanup worth doing: restore `admin_audit` so admin-action audits actually persist.

**Content-seed (legacy labels): PARKED.** da-platform can't read Aurora from the request path, so the live
Confirm uses the default/group template + synced options (the resolved decision). `lib/template-content-seed.ts`
is ready for an optional BATCH pass from the ETL box (Aurora access) if the familiar-label seeding is wanted.
