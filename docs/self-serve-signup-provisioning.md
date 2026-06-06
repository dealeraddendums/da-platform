# Feature — Self-serve signup → DA Platform provisioning (dealers + groups)

> For Claude Code. Owner: Allan. Created 2026-06-02. **Spans da-marketing-os +
> da-platform.** Marketing OS **Phase 5** + DA Platform **Phase 13** — now unblocked
> (new DA Platform is live and owns HubSpot). Turns a marketing-site signup into a
> real **Trial** dealer (or group + group_admin) in DA Platform, firing the existing
> HubSpot/onboarding path, and hands HubSpot ownership to DA Platform.

## ✅ Shipped 2026-06-02 (deployed; browser E2E pending)
Deployed both repos — da-platform `c2fedf3` (new `POST /api/self-serve/signup`,
`SELF_SERVE_API_KEY`, migration `087_self_serve_acquisition`) + marketing-os
`ca40bed` (Turnstile verify, DA Platform handoff, env set). Smoke tests green:
key-auth 401 (no/wrong key) / 400 (valid key, empty body — secret matches
end-to-end), Turnstile 403 on tokenless submit, main app unaffected, both PM2 apps
online. **Pending:** human browser E2E (real signup → Trial dealer/group + passkey
invite) — Turnstile needs a person; run on `https://www1.dealeraddendums.com`.

## Today
- **Marketing `/api/leads`** (da-marketing-os): saves a `marketing_leads` row, creates
  its OWN HubSpot contact (`lib/hubspot.ts → createOrUpdateHubSpotContact`), emails
  Allan + the lead ("we'll reach out to set up your account"). **No dealer/group created.**
- **DA Platform `POST /api/dealers`** (auth: super_admin/group_admin): inserts the
  dealer, fires `fireDealerCreateReliable` (HubSpot Company, `lifecyclestage=Dealer
  Trial` → the Phase-5 onboarding-workflow trigger), optional user create. **Trial
  account types skip the recurring billing template** (no da-billing until conversion).
- Groups: `POST /api/groups`. Onboarding invite: `lib/migration-invite.ts` /
  `app/api/invite/*` (passkey magic-link). [CC: confirm the exact invite-send fn.]

## Architecture — server-to-server (keep DA Platform the source of truth + sole HubSpot writer)
1. Browser → marketing `/api/leads` (unchanged entry; already rate-limited 10/min/IP).
2. Marketing **server** → **new DA Platform endpoint `POST /api/self-serve/signup`**
   with a shared `X-API-Key` (server-to-server; the browser never hits DA Platform).
   New shared secret on both boxes: `SELF_SERVE_API_KEY`.
3. The endpoint creates the Trial dealer (or group + group_admin), fires the existing
   HubSpot reliable-create + sends the onboarding invite, returns `{ dealer_id / group_id }`.
4. Marketing stores the returned ids on the `marketing_leads` row and **stops
   creating its own HubSpot contact** (DA Platform now owns the HubSpot company +
   contact) — keeps `marketing_leads` (+ attribution fields) for marketing analytics.

## DA Platform — `POST /api/self-serve/signup` (new, key-authenticated)
- Auth: `X-API-Key === SELF_SERVE_API_KEY` (no user session); rate-limit defensively.
- Body: `{ name, email, dealership, phone?, accountKind: 'single'|'group', groupName?, attribution? }`.
- **Duplicate guard:** if a `profiles` row exists for this email (or a dealer by
  name) → don't duplicate; return `{ existing: true }` so marketing shows "looks
  like you already have an account — log in." (Honors the migration "avoid
  duplicates" rule.)
- **Single store:** extract a `createTrialDealer()` helper from `POST /api/dealers`
  and create a **Trial** dealer: `account_type='Trial'`, generated `dealer_id`
  (`ss_{internalId}`), `inventory_dealer_id=dealer_id`, `primary_contact=name`,
  `primary_contact_email=email`, `phone`. **Skip da-billing.** Fire
  `fireDealerCreateReliable(dealerId)`. Create a `dealer_admin` profile + **send the
  passkey/magic-link onboarding invite** (the magic link doubles as email verification).
- **Group (multi-rooftop):** create a **Trial Group** (reuse `POST /api/groups`),
  create a `group_admin` profile + send the invite. **Rooftops are added in-platform
  afterward** by the group admin via the existing group_admin `POST /api/dealers`
  (auto-generates `ga_{id}` + sets group_id) — none collected at signup.
- **Attribution:** persist the passed `attribution` (utm/gclid/referrer/landing) on
  the dealer (nullable columns or a jsonb `acquisition`) + as HubSpot properties, so
  the acquisition source lives on the dealer/contact (ties into the attribution work).
- Returns `{ ok, kind, dealer_id?, group_id?, existing? }`.

## Marketing OS — `/api/leads` change
- After the `marketing_leads` insert, call `POST {DA_PLATFORM_URL}/api/self-serve/signup`
  with `X-API-Key` + the body above (incl. `attribution` from the cookie).
- **Remove** the direct `createOrUpdateHubSpotContact` call — DA Platform now owns
  HubSpot (kills the double-write that originally deferred Phase 5).
- Form: add a **"Single store / Dealer group"** choice (+ group name when group);
  pass `accountKind`/`groupName`.

## Anti-abuse — Cloudflare Turnstile (free) + magic-link
- Add a **Cloudflare Turnstile** widget to the signup form(s); include its token in
  the POST to marketing `/api/leads`.
- `/api/leads` **verifies the Turnstile token server-side** (`TURNSTILE_SECRET_KEY`,
  siteverify) before anything — reject on failure (before the `marketing_leads`
  insert or the DA Platform call).
- Env (marketing box): `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (client) +
  `TURNSTILE_SECRET_KEY` (server).
- The **passkey magic-link invite is the email verification** — only the real email
  owner can finish onboarding, so a bot can't get a usable account even if a row exists.

## Resolved decisions
1. **Group signup:** create Group + group_admin invite only; rooftops added
   in-platform later (existing group_admin dealer-create). ✓
2. **Anti-abuse:** Cloudflare Turnstile on the form + magic-link verification (above). ✓
3. **Emails:** DA Platform's passkey invite is the single welcome; marketing **drops
   its own "welcome" email**. Keep the internal new-signup notify. ✓
4. **Trial terms:** standard **30 days / 30 prints** per the lifecycle. ✓

## Verify
- Single-store signup on the new site → a Trial dealer in DA Platform (`account_type`
  Trial, HubSpot `Dealer Trial`), user gets a passkey invite, **no** da-billing
  customer, attribution stored, and exactly ONE HubSpot company/contact (no
  marketing-side duplicate).
- Group signup → Group + group_admin invite; admin can add rooftops in-platform.
- Duplicate email → no duplicate; "log in" response.
- Stop for review before deploy (touches billing-adjacent flow + a key-auth public
  endpoint + HubSpot).
