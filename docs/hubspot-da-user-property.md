# HubSpot Contact property "DA User" = Yes/No

> For Claude Code. Owner: Allan. Created 2026-06-11. da-platform only (extends Phase 14 DA→HubSpot
> sync). **Writes to the live CRM — STOP for review before deploy.** No DA-side migration.

## Goal
Flag every HubSpot **Contact** whose email is a real DA login account with the existing contact
property **"DA User" = Yes**, so HubSpot can finally separate actual platform users from marketing
leads/prospects. (Allan: "just putting a Yes in there for email addresses associated to DA user
accounts.")

## Why this is clean (one source)
DA→HubSpot syncs Contacts **only from `profiles`** — `profileContactProperties(p, companyName)` in
`lib/sync-hubspot.ts:176–191` builds the contact payload from a profile row (`email`, `firstname`,
`lastname`, `phone`, `user_type`, `username`, `user_id`, `dealer_id`, `group_id`, `company`), and the
upsert at `:448–456` writes it (event-driven from `app/api/dealers`, `groups`, `invite/accept`).
**Every contact the sync touches is, by definition, a DA user account.** Marketing/lead contacts are
never touched by this sync, so they stay un-flagged. So the rule is simply: *contact built from a
profile → `da_user = "Yes"`.*

## Prerequisite (CC's FIRST step — confirm against HubSpot, don't assume)
The property already exists ("DA User"). Before writing, **read its definition** via
`GET /crm/v3/properties/contacts/{internalName}` (or list contact properties) to confirm:
1. The **internal name** (label "DA User" → likely `da_user`, but verify — labels ≠ internal names).
2. It's an **enumeration** and the **exact option values** are `Yes` / `No` (HubSpot enum writes must
   match the option's *internal value* exactly, which may differ from the label — e.g. `Yes` vs `yes`
   vs `true`). Use the confirmed strings.
A wrong internal name or option value silently no-ops or 400s — so confirm first.

## Implementation
1. **Live sync** — add one line to `profileContactProperties` (`lib/sync-hubspot.ts:179–190`):
   ```ts
   da_user: "Yes",          // ← use the confirmed internal name + value
   ```
   Now every profile create/update (event-driven + the daily computed cron's contact touches) sets it.
2. **Backfill the ~3,646 existing user-contacts** — the `--profiles` path in
   `scripts/backfill-hubspot.mjs` builds contact props via its own `profileProps(p, companyName)`
   (`:301`) and already scopes to **active** profiles (`:288–292`). Add the same `da_user: "Yes"` there,
   then run **dry-run first**: `node scripts/backfill-hubspot.mjs --profiles` (it has a `[dry]` mode),
   review, then the live run. (Idempotent: PATCHes existing `hubspot_contact_id`, else search-by-email.)
3. **The "No" side** (so segmentation is Yes vs No, not Yes vs blank): set the property's **default value
   to "No"** in HubSpot (property settings) so every contact the sync never touches reads No. The DA sync
   itself only writes "Yes".

### Recommended refinement (clean offboarding → No)
Make it active-aware so a **deactivated** account flips to No going forward:
`da_user: p.active ? "Yes" : "No"`. The live select at `sync-hubspot.ts:420` does **not** currently
include `active` — add `active` to that select + to the `ProfileForHubspot` type (the backfill already
selects `active`). (Hard-deleted profiles aren't re-synced, so a delete-path "No" is a separate small
follow-up — note, don't block.)

## Decisions to confirm (defaults chosen; Allan can veto)
- **Internal DA team** (the 5 `@dealeraddendums.com` super_admins from migration 088) have profiles, so
  they'll read **DA User = Yes** (they are, literally, users). Default: **include them**. If you'd rather
  exclude the team from "DA User," CC sets `No` (or skips) for those emails — one small allowlist. Say
  the word.
- **Dormant/service-provider dealers** that were provisioned but never log in still have a profile, so
  they read Yes. That matches "associated to a DA user account"; flagging here in case you want
  active-only (the active-aware refinement above already excludes deactivated ones).

## Verify
- A known dealer user's HubSpot Contact shows **DA User = Yes**; a known **marketing-lead** contact (no
  DA account) shows **No** (after the default is set).
- Create a brand-new user (invite accept) → their Contact lands with **DA User = Yes** automatically.
- Backfill: dry-run count ≈ active profiles (~3,646); live run reports ~that many updated, 0 errors;
  spot-check 2–3 contacts in HubSpot.
- (If active-aware) deactivate a test user → next sync flips that contact to **No**.
- **STOP for review before the live backfill run** (writes to the live CRM).
