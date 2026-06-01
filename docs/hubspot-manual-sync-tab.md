# Feature — "HubSpot Sync" tab in My Profile (manual sync + live progress)

> For Claude Code. Owner: Allan. Designed in the claude.ai session 2026-05-31.
> A thin UI + streaming route over the **already-built** Phase 14 sync — reuse
> `lib/sync-hubspot.ts`; do not reimplement the upsert logic.

## Goal
Phase 14's event sync fires on changes and a daily cron (`0 8 * * *`) refreshes
computed fields. Support sometimes needs a dealer pushed to HubSpot **right now**
(e.g. after a correction, or if an event-sync was missed). Add a **"HubSpot Sync"
tab** under My Profile with a **Start Sync** button that syncs the current dealer
on demand and shows each step in real time.

## Reuse (already built — commit 3222757)
- `syncDealerToHubspot(dealerId)` — upserts the dealer Company, writes back
  `hubspot_company_id`. (Pushes every record field incl. `prints_last_30` +
  `lifecyclestage`; **not** `prints_last_12mo` / `dealers_in_group` — those are
  cron-only.)
- `syncProfileToHubspot(profileId)` — upserts a user's Contact.
- `hubspotConfigured()` gate. These swallow errors into `hubspot_sync_errors` and
  return void, so determine per-step success by **reading back** the id
  (`dealers.hubspot_company_id` / `profiles.hubspot_contact_id`) — same pattern
  `syncDealerCreateReliable` already uses.

## Scope of one "Start Sync"
1. The dealer's Company (`syncDealerToHubspot`).
2. Every active user of that dealer: `profiles` WHERE `dealer_id = dealer.dealer_id`
   (TEXT slug join, not UUID) → `syncProfileToHubspot(p.id)` each.
Records + contacts cover ~all support-relevant fields. `prints_last_12mo` /
`dealers_in_group` stay with the daily cron (note it in the UI: "computed totals
refresh nightly"). Optional v2: also call the 14b per-dealer compute if it's
exposed.

## API route — `app/api/hubspot/sync/route.ts` (POST, streaming)
- `requireAuth`; resolve the **target dealer from the current context** — the
  caller's own dealer, or the impersonated dealer when in ghost mode (reuse the
  existing ghost-context resolver). 403 if no dealer in context or role not
  permitted (see Permissions).
- Return a streamed `text/event-stream` `ReadableStream`; emit one SSE `data:`
  line per step so the client renders progress live:
  ```
  { step: "start",   message: "Syncing {dealerName}…" }
  { step: "company", status: "running" }
  { step: "company", status: "done" | "error", hubspotId? }
  { step: "contact", email, status: "running" }
  { step: "contact", email, status: "done" | "error" }   // one pair per user
  { step: "done",    okCount, errorCount }
  ```
- For each step: call the reuse fn, then read back the id → `done` if present,
  else `error` (point the user at `hubspot_sync_errors`). Headers:
  `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
  `X-Accel-Buffering: no` (so nginx doesn't buffer the stream).

## Client — `HubSpotSyncTab` in `app/(dashboard)/profile/`
- "Start Sync" button (primary `#1976d2`); disabled while running.
- POST to `/api/hubspot/sync` and read the response body as a stream
  (Fetch streaming — `res.body.getReader()`; EventSource is GET-only so don't use
  it). Parse each `data:` line and append to a live list below the button:
  spinner while `running`, green ✓ on `done`, red ✗ on `error`, with the company
  name + each contact email. End with a summary line ("Company + N contacts
  synced" / "M failed — logged").
- Design-system only: white card, `1px #e0e0e0` border, no shadow, Roboto; badge
  palette for ✓/✗. No new colors.

## Tab wiring (`ProfileClient.tsx`)
- Extend `type Tab` with `"hubspot"`.
- Add to `ALL_TABS`: `{ id: "hubspot", label: "HubSpot Sync", dealerOnly: true,
  staffOnly: true }` (add a `staffOnly` flag to the array type + the
  `visibleTabs` filter).
- Render `{tab === "hubspot" && dealer && <HubSpotSyncTab dealer={dealer} />}`.

## Permissions — CONFIRMED: super_admin only
**Confirmed by Allan 2026-05-31:** the tab + route are **super_admin only**
(including when ghosting a dealer). HubSpot is DA's internal CRM — never exposed
to dealer logins. The route enforces it server-side (403 for any non-super_admin);
the `staffOnly` tab flag hides it from everyone else.
- Alternative/extra home: a "Sync to HubSpot" button on the **super-admin dealer
  detail page** is a natural fit for "sync *any* dealer" without impersonating —
  say the word and I'll spec that too.

## Verify
- As super_admin ghosting a test dealer → HubSpot Sync tab appears → Start Sync →
  live log shows company + each contact ✓; HubSpot record reflects the edits.
- Force a failure (bad token) → step shows ✗ and a row lands in
  `hubspot_sync_errors`; the page stays responsive.
- Confirm a normal dealer_admin login does NOT see the tab (default gate).

## Status
Decisions locked (super_admin-only) — ready to build. The optional super-admin
dealer-detail "sync any dealer" button (above) remains a nice-to-have, not required.
