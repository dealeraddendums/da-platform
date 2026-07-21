# Fortellis Feed Integration — Planning Spec

> **Status:** ✅ SHIPPED 2026-07-18 — live on prod (commits `6f03e38` feature + `b9a4f8d` health-classification fix; **migration 133 applied**). CC prompt: `cc-prompt-fortellis-dealers.txt`; Phase 0 findings: `da-platform/docs/fortellis-samples/FINDINGS.md`.
> **Outstanding:** (1) EasyCron hourly-delta job — dashboard-registered, see §5b; (2) CDK must activate DA's Test subscription (Test calls currently 400 "Invalid SubscriptionId or Implementation provider is not configured" — path/auth verified correct); live vehicle E2E + the DOWN→UP alert simulation are deferred until then.
> **Owner:** Allan | **Authored:** 2026-07-18 (planning Claude)
> **Context:** CDK PIP sunset Oct 23, 2026 — see `cdk-fortellis-migration-brief.md`
> **Decisions (Allan, 2026-07-18):** engine lives in **da-platform + EasyCron**; writes **Supabase only** (`dealer_vehicles`); Workflow Template doc filled out in parallel.
> **As-built divergences (CC, folded in):** token call requires **`scope=anonymous`** (400 without it); env-specific service paths `/{cdk|cdk-test}/sales/inventory/v2/merchandisable-vehicles`; per-dealer scoping is `web_id`/`dealer_code` (no Department-Id); **sold = `dealer_vehicles.status='inactive'`** (canonical — no 'sold' enum; printed rows `print_status=1` and manual vehicles never touched); build fix: `ssh2-sftp-client`/`ssh2` added to `serverComponentsExternalPackages` (pre-existing blocker from feed-push.ts).

---

## 1. What this is

Fortellis (CDK's API platform) replaces the CDK PIP extract. DA's Fortellis app is registered, the **CDK Drive Get Merchandisable Vehicle** API is integrated (accepted 2026-07-16), and OAuth credentials exist. This spec covers:

1. **`/admin/fortellis-dealers`** — new super_admin tab in FEEDS, directly **below CDK Dealers**, mirroring that page's look and behavior.
2. **Sync engine** — bulk pull at dealer install, **hourly delta 5:00am–9:00pm PT** (adds, updates, marks sold), **on-demand full re-sync** (per dealer + fleet-wide).
3. **Error reporting + availability alerting** — per-run error summaries like the CDK tab, plus a down/up state machine that emails when the Fortellis API is unavailable.
4. **Certification-grade request/response logging** (Fortellis requires complete request+response logs, retained ≥60 days, JWTs masked).

The existing CDK Dealers tab stays untouched and runs in parallel until cutover signoff.

## 2. Confirmed API contract (official Developer Guide, 2025-11-20 — PDFs in `da-fortellis/`)

Source docs: `da-fortellis/CDK-Drive-Get-Merchandisable-Vehicles-v2-Developer-Guide.pdf` (128 pp) + `CDK-Drive-Merchandisable-Vehicles-Field-Mapping-Guide.pdf` (PIP→v2 field map). These replace the earlier Phase-0 unknowns.

- **Auth:** OAuth 2.0 client-credentials. `POST https://identity.fortellis.io/oauth2/aus1p1ixy7YL8cMq02p7/v1/token`, HTTP Basic (API key : secret), body `grant_type=client_credentials`. **Bearer tokens live 1 hour** — cache and refresh at ~55 min.
- **Service URL:** `https://api.fortellis.io/cdk/sales/inventory/v2/merchandisable-vehicles`
  - `GET /` = **vehicleSearchUsingGET** (synchronous — NO async job/poll pattern)
  - `GET /ping` = connectivity test (our health probe)
- **Required headers:** `Authorization: Bearer …`, `Subscription-Id` (per-dealer Marketplace subscription; `test` returns canned samples), **`Request-Id` (client-supplied GUID, unique per request — REQUIRED and echoed back)**, `Accept: application/json`.
- **Dealer scoping:** results are limited to the subscription's dealer; queries additionally require **`dealerCode`** (CDK DMS dealer code, e.g. `5236a`) or `dealerType` or `webId` (dealer's CDK-website ID, e.g. `motp-whiteallenhonda-cdkinv`).
- **Delta:** `modifiedTimeRange=<startUTC>:<endUTC>` — format `YYYY-MM-DDThh:mm:ss.sssZ`, colon-separated range. This is the hourly delta mechanism.
- **Sold/removed detection:** `deleted=true` returns vehicles with deleted status (default false). ⚠️ Legacy `SoldDate`/`SoldMileage`/`Wholesale` fields are **NOT supported in v2** — sold = deleted-record pull + `vehicleStatus.inventoryStatus` transitions.
- **Pagination:** `limit` (default 10, **max 100**) + `offset`; iterate until `summary.totalCount` covered. Default sort `createdDate|asc`.
- **Financials:** `includeAllPrices=true` includes the `financials` section (prices array); response omits `financials` when data isn't provided.
- **Rate limiting:** HTTP 429 issued when exceeding the subscribed rate limit — hourly delta cadence complies with the Workflow guidelines (≤1/hour, off during non-business hours).
- **Response shape:** `{ filters[], metadata, results[], summary { totalCount, displayableCount, limit, offset } }` — vehicles live in `results[]`.
- **Subscription discovery:** the Fortellis Subscriptions endpoint lists all subscription IDs for the app — how new dealer activations are detected.
- **Logging requirement (certification):** complete request AND response (headers + payloads) for every API transaction, retained ≥60 days, with the `Request-Id` capturable for support tickets. JWTs must be masked/obscured in storage.
- **Pricing note:** Bulk queries are billed outside the monthly plan — hourly runs must use the delta (`modifiedTimeRange`) query, not repeated full pulls.

### Field mapping (PIP → v2, per the Mapping Guide; all under `results[]`)

| dealer_vehicles | v2 attribute (legacy PIP field) |
|---|---|
| vin | `vin` (VIN) |
| stock_number | `stockNumber` (StockNo) |
| year | `year` (Year) |
| make | `make` (MakeName) |
| model | `model` (Model) |
| trim | `trim` (TrimLevel; `originalTrim` also present) |
| body_style | `bodyStyleClassification` (BodyStyle); `bodyType` enum also available |
| exterior_color | `color.exterior.baseColor` (Color) |
| interior_color | `color.interior.baseColor` (InteriorColor) |
| mileage | `odometer.value` (Mileage) |
| msrp | `financials.prices[].type='BASE_RETAIL'` → `.amount` (BaseRetailPrice) |
| internet_price | `financials.prices[].type='ADVERTISED'` → `.amount` (AdvertisedPrice) |
| condition | `category` — new / used / certified (Certified) |
| status | `vehicleStatus.inventoryStatus` (Status; e.g. In-stock, In-transit) + `deleted` flag |
| date_in_stock | `createdDate` (EntryDate); `lotDate` = ReceivedDate |
| — | `lastModifiedDate` (LastActivityDate) drives delta reconciliation |

Note: `DealerDefined1-8` are NOT supported in v2 — the CDK stock-number fallback via DealerDefined1 is gone; fall back to VIN when `stockNumber` is empty.

## 3. Data model (migration 133 — confirm number before creating)

```sql
-- fortellis_dealers: one row per dealer connection (Marketplace subscription)
create table fortellis_dealers (
  id            bigint generated always as identity primary key,
  dealer_name   text not null,
  subscription_id text not null unique,   -- Fortellis Subscription-Id
  dealer_code   text,                     -- CDK DMS dealer code (query param; e.g. '5236a')
  web_id        text,                     -- dealer's CDK-website ID (alt query param)
  dealer_id     text,                     -- dealers.dealer_id (Supabase text key) — resolved at add time
  is_new        boolean not null default true,   -- parity with cdk_dealers.NEW: bulk install not yet run
  enabled       boolean not null default true,   -- excluded from hourly delta when false
  last_delta_at timestamptz,              -- per-dealer delta watermark
  last_full_sync_at timestamptz,
  last_status   text,                     -- 'ok' | error summary from most recent run
  created_at    timestamptz default now()
);

-- fortellis_api_log: certification logging (≥60-day retention; purge >90 days)
create table fortellis_api_log (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  subscription_id text,
  method        text not null,
  url           text not null,
  request_id    text,                     -- Fortellis Request-Id header
  http_status   integer,
  duration_ms   integer,
  request_headers jsonb,                  -- Authorization MASKED ("Bearer ####…")
  response_body text,                     -- complete payload (cert requirement)
  error         text
);
create index fortellis_api_log_at_idx on fortellis_api_log (at);
```

Health/run state lives in `admin_settings` (same pattern as `cdk_bulk_update_status`): keys `fortellis_sync_status` (run progress JSON) and `fortellis_health` (`{state:'up'|'down', since, last_error, last_alert_at}`).

RLS enabled, no policies (service-role only) — same posture as `feed_companies` / `admin_audit`.

## 4. Library — `lib/fortellis-api.ts`

Modeled on `lib/cdk-api.ts`:

- Token manager: module-level cache, refresh at 55 min, single-flight refresh.
- `getSubscriptions()` — list app subscriptions (used by the Add-dealer modal to offer a picker, and by a "Detect new subscriptions" action).
- `searchVehicles(dealer, opts)` — vehicleSearchUsingGET with `dealerCode` (or `webId`), `includeAllPrices=true`, `limit=100` + `offset` pagination until `summary.totalCount` is covered; `opts.modifiedTimeRange` for deltas, `opts.deleted` for the sold pull. Generates a GUID `Request-Id` per request.
- `ping()` — `GET /ping` (documented connectivity test).
- `mapVehicle(raw)` → the exact `dealer_vehicles` insert shape used by `importOneDealer` in `app/api/admin/cdk/bulk-update/route.ts` (same `clip`/`clamp` guards, VIN uppercased, `created_by: 'FORTELLIS_DELTA' | 'FORTELLIS_BULK'`).
- `logCall(...)` fire-and-forget via `fireWrite()` (`lib/db.ts`) — Authorization masked.

Env (`.env.production`):

```
FORTELLIS_API_KEY=…
FORTELLIS_API_SECRET=…
FORTELLIS_TOKEN_URL=https://identity.fortellis.io/oauth2/aus1p1ixy7YL8cMq02p7/v1/token
FORTELLIS_API_BASE=…        # from Phase 0 (test vs prod URLs differ per Fortellis docs)
FORTELLIS_ENV=test          # 'test' | 'production' — flipped at Production phase
```

## 5. Sync flows

### 5a. Install (bulk) — once per new dealer
Trigger: dealer row added on the tab (or Import clicked while `is_new`). Full inventory pull → insert-only against existing VINs (dedup like CDK import), flip `is_new=false`, stamp `last_full_sync_at` and `last_delta_at=now()`.

### 5b. Hourly delta — `POST /api/cron/fortellis-delta`
- Auth: `X-Cron-Secret` (same as other crons). EasyCron job: hourly at :05, **timezone America/Los_Angeles, first run 5:05 AM, last run 9:05 PM** (17 runs/day).
- Refuses to overlap a running job (status check, like CDK bulk-update's 409).
- Loop over `enabled` dealers, per-dealer watermark `last_delta_at`. Two queries per dealer: (a) `modifiedTimeRange={watermark}:{now}` for adds/updates, (b) same range + `deleted=true` for sold/removed:
  - **Add** unseen VINs (insert, `created_by='FORTELLIS_DELTA'`).
  - **Update** existing VINs on changed fields (price, mileage, colors, trim, certified, …) — only rows originally fed by CDK/Fortellis; never clobber manually-edited vehicles (respect the same guardrails Phase 0 confirms exist for print status: **never overwrite a vehicle already marked printed** — parity with ETL Job 6's rule).
  - **Mark sold**: vehicles the delta reports sold/removed → `dealer_vehicles.status` set to the platform's existing inactive value (CC confirms the canonical value — `'sold'` vs `'inactive'` — from current schema usage before coding). Print history untouched.
  - Advance `last_delta_at` only on success for that dealer.
- Per-dealer 30s abort timeout; error taxonomy (`auth_401`, `no_supabase_dealer`, `timeout`, `other`) identical to CDK.

### 5c. On-demand full sync
- Per-dealer **Full Sync** button → same as install but upsert semantics (add + update + mark sold by diff against the full snapshot).
- Fleet-wide orange **Fortellis Update** button → background loop with progress polling (`admin_settings` status JSON + status route), mirroring CDK Update's UI exactly.

## 6. Error reporting + availability alerting

- **Per-run errors:** captured in the status JSON, rendered in the same error-summary panel as the CDK page (with Retry-failed and Remove-unauthorized actions).
- **401 email:** same Mandrill email to `support@dealeraddendums.com` as CDK ("dealer may have unsubscribed from DA on the Marketplace").
- **API availability state machine** (`fortellis_health` in `admin_settings`):
  - Mark **DOWN** when the token endpoint fails, or a run ends with 100% network/5xx failures, or the pre-run ping fails.
  - On transition up→down: Mandrill alert to `support@dealeraddendums.com` + `allan@dealeraddendums.com` ("Fortellis API unavailable since {time}; last error {…}"). Re-alert at most every 6 h while down (no hourly spam).
  - On transition down→up: recovery email.
  - Tab shows a red banner while down (green "API healthy — last successful call {time}" otherwise).

## 7. UI — `/admin/fortellis-dealers`

- Sidebar: FEEDS → **"Fortellis Dealers"** immediately below "CDK Dealers" (`components/Sidebar.tsx`). super_admin only.
- Page is a structural clone of `app/(dashboard)/admin/cdk-dealers/page.tsx` (PageHeader, white cards, `1px solid #e0e0e0`, no shadow, Roboto, blue `#1976d2` primaries, orange `#ffa500` for the bulk Update button):
  - Table: Dealer Name · Subscription ID · Matched dealer (`dealer_id`) · NEW badge · Last Delta · Last Full Sync · Status · row actions **Test / Full Sync / ✕**.
  - **Add Dealer** modal *(as-built, `4613e6a`)*: searchable dealer picker over existing dealers replaces free-text name; selection autofills dealer_name, read-only dealer_id chip, and dealer_code (from `cdk_dealers.DEALER_ID` match, else `inventory_dealer_id` fallback); subscription↔dealer cross-fill (orgName seeding / name-match preselect); manual Subscription-Id paste fallback; dup-guard blocks save when the dealer already has a `fortellis_dealers` row. Mapping helper: `lib/fortellis-autofill.ts resolveDealerAutofill()` (shared with the Phase 5 cutover converter).
  - **Test** button: live one-call probe, shows vehicle count (parity with CDK Test).
  - **Fortellis Update** orange button: fleet full sync with progress + error summary.
  - Health banner (per §6). Sort: NEW first, then alphabetical. Exclude test/allan pattern on fleet runs.
- API routes under `/api/admin/fortellis/…` + `/api/admin/fortellis-dealers/…`, all `requireSuperAdmin()`, mirroring the CDK route layout.

## 8. Log retention

Extend the existing purge cron (or add a small daily task) to delete `fortellis_api_log` rows older than **90 days** (requirement is ≥60).

## 9. Phasing for CC

- **Phase 0 — Live verification (sandbox; the contract is already documented in §2):** token → subscriptions (capture what identifying metadata each subscription carries — feeds the Phase 5 auto-matcher) → sample vehicleSearchUsingGET + `/ping` with `Subscription-Id: test`; verify §2 against live behavior (esp. whether `financials` requires `includeAllPrices=true`, and `dealerCode` vs `webId` availability per dealer); save raw samples to `docs/fortellis-samples/`.
- **Phase 1 — Migration 133 + `lib/fortellis-api.ts` + logging.**
- **Phase 2 — Admin tab + routes (Add/Test/Import/Full Sync/Fortellis Update).**
- **Phase 3 — Hourly delta cron + EasyCron registration + availability alerting.**
- **Phase 4 — Certification support:** run the documented workflows end-to-end in sandbox, export logs from `fortellis_api_log` for the Business Process Consultant; then flip `FORTELLIS_ENV=production` + prod URLs at Deployment.
- **Phase 5 — CDK→Fortellis cutover helper (Allan's plan, 2026-07-18):** after certification + CDK migrates all dealer PIP subscriptions (within 10 days of cert), a one-time super_admin action **"Convert from CDK Dealers"**: copies every `cdk_dealers` row into `fortellis_dealers`, auto-matching each dealer to its Fortellis **Subscription-Id** via `getSubscriptions()` (match on dealer name / CDK dealer id in the subscription's org metadata); unmatched rows land in the table unmapped and clearly flagged for manual Subscription-Id entry. All converted rows get `is_new=true`; the fleet **Fortellis Update** run then performs the initial pull with **full-sync reconcile semantics** (not insert-only) so vehicles already in Supabase from old CDK pulls are updated and stale ones marked sold — no duplicates (VIN dedup) and no stale carryover. The CDK Dealers tab is then retired (leave read-only until the PIP sunset for rollback comfort).

## 10. Open items / risks

- ~~Exact API contract~~ **RESOLVED 2026-07-18** — official Developer Guide + Field Mapping Guide obtained (see §2). Remaining live checks: `financials`/`includeAllPrices` behavior, per-dealer `dealerCode` availability, subscription metadata shape.
- **Sold semantics:** v2 has no `SoldDate` — sold detection relies on `deleted=true` + status transitions. Verify during pilot that a sold unit actually surfaces via the deleted query within the hourly window.
- **Legacy 4.0 CDK dealers:** decision 2026-07-18 = Supabase-only. No CDK dealers are V5.0-migrated today; the cutover plan (Phase 5) is: once certified + live, convert CDK dealer IDs to Fortellis Subscription-Ids, set all Fortellis feeds to New, and run the initial pulls. Note the 4.0/Aurora side stops receiving CDK inventory at PIP sunset regardless — CDK dealers' platform migration to V5.0 rides the normal migration-wave timeline (4.0 sunset messaging), so sequence their waves ahead of Oct 23 where possible.
- **Fortellis app secret** appears in a screenshot shared during planning — regenerate via "Generate New Secret" in the dev console before production go-live (cheap insurance; update `.env.production` when done).
- **Certification fee** auto-charges ~31 days from the welcome email — check the date on the payment method on file.
- **Costs:** delta calls are in-plan; bulk pulls are billed separately — the fleet-wide Fortellis Update button should warn about this once pricing is confirmed with CDK.
