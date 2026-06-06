# Phase 14 — HubSpot Sync (DA Platform → HubSpot) — Build Spec

> For Claude Code. Owner: Allan. Scoped + confirmed in the claude.ai session 2026-05-30.
> **One-way DA Platform → HubSpot.** Keep the support-critical fields from the
> 2026-05-27 property export current. DA Platform is the single source of truth.
> All field sources are confirmed below — every value comes from the
> dealer/group/profile **Supabase columns** (no da-billing reads needed).
> Private-app token must be created (see below).

Portal `23896347`. Company URL `/record/0-2/{id}`, Contact `/record/0-1/{id}`.

## Current state (already built — do NOT rebuild)
- Supabase already stores link IDs: `dealers.hubspot_company_id`,
  `groups.hubspot_company_id`, `profiles.hubspot_contact_id`; the Legacy ETL fills
  them from Aurora for migrated records.
- Dealer/group/user pages already deep-link to HubSpot.
- **Missing = the write path.** No HubSpot API client in da-platform. Reuse the
  client shape from da-marketing-os `lib/hubspot.ts` (`api.hubapi.com/crm/v3`,
  `Authorization: Bearer`, 409 → existing-id), but a separate token/scope.
- All target properties already exist in the portal (they're in the export) →
  **populate, not create-schema.**

## Step 0 — confirm live property internal names first
The 5/27 export labels may differ from internal names. Before wiring, `GET
/crm/v3/properties/companies` and `/crm/v3/properties/contacts` and confirm the
exact internal names for: `dealerid`, the DA-Platform ID (export shows
`da_dealer_`; Allan calls it `platformid` — **use whichever the portal actually
has**), `billingid`, `groupid`, `subscription_type`, `sub_billing_to`,
`feed_company`, `feed_company_type`, `prints_last_30`, `prints_last_12mo`,
`dealers_in_group`, `billing_contact_*`, and the `lifecyclestage` stage values
(`Trial`, `Trial Expired`, `customer`). Map to the real names; don't hardcode the
export labels.

## Architecture — mirror the da-billing sync
- `lib/hubspot.ts` — typed client + `hubspotConfigured()` gate (like
  `billingConfigured()`). `upsertCompany(dealerOrGroup)`, `upsertContact(profile)`,
  `getCompany(id)`.
- **Non-blocking, fire-and-forget** from the same lifecycle call sites that notify
  da-billing today (dealer/group/user create+update, group add/remove, deactivate,
  upgrade). Never `await` in the request path: `void hubspotSync(...).catch(log)`.
- **Errors → new `hubspot_sync_errors` table** (mirror `billing_sync_errors`):
  `{ id, object_type, object_id, hubspot_id, op, error, payload jsonb, created_at }`.
- **Idempotent matching:** (1) row has `hubspot_company_id`/`hubspot_contact_id` →
  PATCH; (2) else search (company by `platformid`/`dealerid`, contact by `email`)
  → PATCH + store id back; (3) else POST create → store returned id on the row.

## The four customer IDs (confirmed)
| HubSpot Company prop | DA source | meaning |
|---|---|---|
| `dealerid` | `dealer.inventory_dealer_id` | Dealer Inventory ID |
| `platformid` (export: `da_dealer_`) | `dealer.dealer_id` | DA-Platform ID (text slug, e.g. `qa-test-dealer-a`) |
| `billingid` | `dealer.billing_customer_id` ?? `dealer.internal_id` | DA-Billing ID |
| `groupid` | `dealer.group_id` → `group.internal_id` | DA-Platform Group ID |

## Field mapping — Company ⟵ dealer (`DealerRow`) / group (`GroupRow`)
| HubSpot property | DA source |
|---|---|
| `name` | `dealer.name` (group: `group.name`) |
| `address` / `city` / `state` / `zip` / `country` | `dealer.address/city/state/zip/country` |
| `phone`, `dealership_phone` | `dealer.phone` |
| `company_email` | `dealer.primary_contact_email` |
| `dealerid` / `platformid` / `billingid` / `groupid` | per the four-ID table above |
| `dealer_group` | `group.name` (via `dealer.group_id`) |
| `dealers_in_group` | COUNT(dealers WHERE group_id=…) — computed (14b) |
| `sub_billing_to` | `dealer.sub_billing_to` |
| `subscription_type` | `dealer.account_type` (the plan tier — confirm it holds Manual/Auto-Web/Auto-DMS) |
| `billing_contact_mailing_address` | `dealer.billing_street` |
| `billing_contact_city` / `_state` / `_zip` | `dealer.billing_city` / `billing_state` / `billing_zip` |
| `billing_contact_name` | `dealer.billing_to` (fallback `primary_contact`) |
| `billing_contact_email` | `dealer.primary_contact_email` (dealers have no billing_email column) |
| `billing_contact_phone_number` | `dealer.phone` (dealers have no billing_phone column) |
| `feed_company` | `dealer.inventory_provider` (CDK/Tekion/vAuto) |
| `feed_company_type` | `dealer.inventory_provider_is_dms ? "Auto-DMS" : "Auto-Web"` |
| `prints_last_30` | `dealer.last30` |
| `prints_last_12mo` | aggregate `print_history` over 12 mo — computed (14b) |
| `lifecyclestage` | Trial / Customer / Trial Expired — see logic below |
| `type`, `superuser` | **drop — unused in the new platform** |
| `hs_state_code`, `source_form` | **leave HubSpot-managed — do not push** |

Groups are also Companies: push `name`, `groupid`, `dealers_in_group`,
`billing_*`, and lifecyclestage (groups default to Customer; some Trial).

## Field mapping — Contact ⟵ user (`ProfileRow`)
| HubSpot property | DA source |
|---|---|
| `email` | `profile.email` (also the search key) |
| `firstname` / `lastname` | split `profile.full_name` on first space |
| `phone` | `profile.phone` |
| `user_type` | `profile.role` |
| `username` | `profile.email` (login username = email) |
| `user_id` | `profile.email` (per Allan — both username & user_id = email) |
| `dealer_id` | `profile.dealer_id` (text slug, matches company `platformid`) |
| `group_id` | `profile.group_id` |
| `company` | `dealer.name` (lookup via `dealer_id`) |
| `lifecyclestage` | inherit the dealer's stage |

## Lifecycle stage logic (confirmed — DA is source of truth, overrides HubSpot)
- Paying account → **Customer**.
- New individual dealer → **Trial**. Trial is capped at **30 days OR 30 prints**;
  past either → **Trial Expired**.
- Most **group** dealers start **Customer** (some Trial).

Compute:
```
if dealer is on a paying plan       → "customer"
else /* Trial */
   trialStart = dealer.first_login_at ?? dealer.created_at      // CONFIRM which
   prints     = count(print_history WHERE dealer & printed_at >= trialStart)  // total since trial start
   if (now - trialStart > 30 days) OR (prints > 30) → "Trial Expired"
   else → "Trial"
```
- Trial→Customer (upgrade) is **event-driven**. Trial→Trial Expired happens by
  time/print accrual with no edit event → re-evaluate in the **daily cron (14b)**.
- "Paying" determinant + `Trial`/`Trial Expired` HubSpot stage internal names →
  confirm in Step 0 / with Alex.

## Trial creation = immediate + reliable (kicks off HubSpot onboarding)
A **new individual-dealer (Trial) creation triggers a HubSpot onboarding
workflow** that enrolls the moment the Company/Contact lands with
`lifecyclestage = Trial`. So the *create* path is held to a higher bar than the
general fire-and-forget updates — it must be prompt and must NOT fail silently:
- On new-dealer create, sync in order: **Company first**, then the Contact(s)
  associated to it, with `lifecyclestage=Trial` in the same create payload so the
  workflow's enrollment trigger fires right away.
- Still don't block the HTTP response, but make the create reliable: immediate
  retry (~3× short backoff); on final failure write `hubspot_sync_errors` **and
  raise an alert** (Mandrill to support) — a silent miss means a new dealer's
  onboarding never starts.
- Group dealers usually create as Customer (no trial workflow) — see lifecycle logic.
- **Cross-ref:** the consumer of this trigger is **Marketing OS Phase 5 (Trial
  Provisioning / onboarding workflow)**, built when we resume Marketing OS. This
  DA→HubSpot trial-create sync is its trigger source — keep the create event
  immediate so that wiring is drop-in later.

## Build phases
- **14a — records (event-driven, P0).** `lib/hubspot.ts` + `hubspot_sync_errors`
  migration. Hook dealer/group/user create+update (`app/api/dealers`, `/groups`,
  `/users`) to upsert Company/Contact with every Supabase-sourced field above
  (including billing_*, subscription_type, the four IDs). Store new HubSpot ids
  back. Set lifecyclestage on create (Trial for new individual dealers) and on
  upgrade (→ Customer).
- **14b — computed + expiry (daily cron).** EasyCron job (pattern: ChromeData
  report) refreshes `prints_last_30` (`dealer.last30`), `prints_last_12mo`
  (`print_history`), `dealers_in_group`, and re-evaluates Trial → Trial Expired.
- **Backfill (one-time).** `scripts/backfill-hubspot.mjs`, dry-run-first (like the
  PDF backfill), pushes every active dealer/group/user once. Mostly PATCH since
  link ids already exist.

## HubSpot private-app token — install on the EC2
The private app is created. Scopes (for reference / if it's ever recreated):
`crm.objects.companies.read`, `crm.objects.companies.write`,
`crm.objects.contacts.read`, `crm.objects.contacts.write`,
`crm.schemas.companies.read`, `crm.schemas.contacts.read`. Search + associations
are covered by the object scopes. The **access token** (`pat-na1-…`) is the
`Bearer` credential; the **client secret** is NOT used (one-way push — no OAuth,
no inbound webhooks).

Install on the da-platform EC2. `.env.production` is gitignored, so the token
NEVER goes in the repo and must not be echoed into logs or committed:
```bash
cd /var/www/da-platform
# Replace PASTE_TOKEN_HERE with the real pat-na1-… token, then run:
grep -q '^HUBSPOT_PRIVATE_APP_TOKEN=' .env.production \
  && sed -i "s|^HUBSPOT_PRIVATE_APP_TOKEN=.*|HUBSPOT_PRIVATE_APP_TOKEN=PASTE_TOKEN_HERE|" .env.production \
  || printf 'HUBSPOT_PRIVATE_APP_TOKEN=%s\n' 'PASTE_TOKEN_HERE' >> .env.production
grep -q '^HUBSPOT_PORTAL_ID=' .env.production || echo 'HUBSPOT_PORTAL_ID=23896347' >> .env.production
pm2 restart da-platform --update-env
# confirm it loaded without printing the value:
grep -q '^HUBSPOT_PRIVATE_APP_TOKEN=' .env.production && echo "token line present (value hidden)"
```
Keep distinct from the marketing-site `HUBSPOT_API_KEY`.

## Verify
- Create a test dealer + user in DA → HubSpot Company/Contact appear with mapped
  fields + the four IDs; new ids land on the Supabase rows; lifecyclestage=Trial.
- Edit dealer address/phone → Company updates within seconds.
- Simulate a Trial past 30 days/prints → cron flips it to Trial Expired.
- Bad token → app unaffected, row in `hubspot_sync_errors`.

## Remaining micro-confirms (Alex, non-blocking — pick defaults if unsure)
1. `subscription_type` column — is `dealer.account_type` the plan tier
   (Manual/Auto-Web/Auto-DMS), or is there a dedicated column?
2. "Paying" determinant for Customer vs Trial, and the trial-start date field
   (`first_login_at` vs `created_at`).
3. Exact HubSpot `lifecyclestage` internal names for Trial / Trial Expired.
