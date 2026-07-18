# Fortellis Phase 0 — Discovery Findings (2026-07-18)

Live sandbox calls made with the DA app's OAuth key/secret + the authoritative
**CDK Drive Get Merchandisable Vehicles v2 (MVS2)** Developer Guide + Field Mapping Guide
(samples 06, 07 — the real spec, provided mid-build). Raw samples in this folder (tokens masked).

## ✅ Verified live

### OAuth token
- `POST https://identity.fortellis.io/oauth2/aus1p1ixy7YL8cMq02p7/v1/token`
- HTTP Basic (key:secret), body `grant_type=client_credentials&scope=anonymous`.
  - **⚠️ `scope=anonymous` is REQUIRED** — without a scope the server 400s
    (`invalid_scope`). The CC prompt omitted this.
- Returns `{token_type:"Bearer", expires_in:3600, access_token, scope:"anonymous"}`.
  1h tokens → cache + refresh at ~55 min. (sample 01)

### Subscriptions endpoint
- `GET https://subscriptions.fortellis.io/v1/solution/subscriptions`, `Authorization: Bearer`.
- Returns `{subscriptions:[{subscriptionId, orgId, orgName, dealerCodes[], status, activationDate,
  deactivationDate, environment, apiDmsInfo[]}]}`. (sample 02)
- Our app has **2 subscriptions**, both `status:"inactive"`: `81e14883-…` (DEALER ADDENDUMS,
  INC., **Test**) and `494f5750-…` (760-1 CDK FS, **Production** demo). `orgName` = the label
  for the Add-Dealer picker.

## ✅ The real API contract — CDK Drive Get Merchandisable Vehicles v2

**This is a synchronous paginated search — NOT the async bulk/delta long-operations family.**
(My initial inference from the public "Get Service Vehicle" sibling was wrong; the provided
MVS2 guide is authoritative and the code is built to it.)

- **Service URL:** `https://api.fortellis.io/{ns}/sales/inventory/v2/merchandisable-vehicles`
  where `{ns}` = `cdk` (production) or `cdk-test` (test). This is the base for all methods.
- **Methods:**
  - `GET /` — **vehicleSearchUsingGET**, returns matching inventory records.
  - `GET /ping` — connectivity probe.
- **Required headers:** `Authorization: Bearer`, `Subscription-Id`, `Request-Id` (GUID, echoed
  back). Optional: `Accept: application/json`, `Accept-Charset: UTF-8`, `Accept-Language`,
  and a `dealerCode` header (can also be a query param). **No Department-Id** (that was a
  Service-Vehicle-family thing).
- **Per-dealer scoping:** `webId` (dealer's unique CDK site id, e.g.
  `motp-whiteallenhonda-cdkinv`) OR `dealerCode` (CDK DMS dealer code) OR `dealerType`
  (WEB / Inventory). The workflow examples all pass `webId`. Subscription data is already
  limited to that subscription's dealer, so these are refinement filters — captured per dealer
  on the tab, sent when present.
- **Pagination:** `limit` (default 10, **max 100**) + `offset` (default 0). Response envelope:
  `{ summary:{ count, totalCount, limit, offset }, results:[…] }`. Iterate `offset` in steps of
  the page size until `offset+limit >= summary.totalCount`.
- **Delta (recently modified):** query param
  `modifiedTimeRange=<start>:<end>` where each is `YYYY-MM-DDThh:mm:ss.sssZ` (UTC),
  colon-separated. Used for the hourly delta window.
- **Sold / removed signal:** `SoldDate` is **NOT supported** in MVS2 (explicitly listed as
  unsupported). Removal is surfaced via **`deleted=true`** (query returns records with a deleted
  status) and the per-record `deleted` boolean + `marketable` / `vehicleStatus.inventoryStatus`.
  → **Sold strategy:** the hourly delta makes a second `deleted=true&modifiedTimeRange=…` pass
  to mark removals; the periodic **Full Sync** does an authoritative snapshot reconcile (any
  Fortellis-fed VIN absent from the current full snapshot → marked `status='inactive'`).
- **Records live in `results[]`.** Field mapping to `dealer_vehicles` (from sample 07):
  - `vin` → vin, `stockNumber` → stock_number, `year` → year, `make` → make, `model` → model,
    `trim` → trim, `bodyStyleDescription`/`bodyStyleClassification` → body_style,
    `color.exterior.baseColor`/`.name` → exterior_color, `color.interior.baseColor`/`.name`
    → interior_color, `odometer.value` → mileage, `createdDate`/`lotDate` → date_in_stock.
  - **condition/certified:** top-level `category` ∈ `new|used|certified|demo`
    (certified → certified='Y', used/demo → Used, new → New).
  - **msrp:** `financials.prices[]` type `BASE_RETAIL|RETAIL|MSRP` (present only with
    `includeAllPrices=true`) → else `mathbox.{cash,lease}.priceLineItems[]` type `RetailPrice`.
  - **internet_price:** `financials.prices[]` type `ADVERTISED|SELLING` → else mathbox
    `SalePrice` line.

## Canonical platform decisions folded into the build
- **Mark sold = `dealer_vehicles.status = 'inactive'`** — confirmed canonical value (used by
  archive-vehicles cron, clear-manual-vehicles, inventory-dealer-id reassignment). No `'sold'`
  enum exists. Print history untouched.
- **Never overwrite printed:** delta UPDATEs skip rows with `print_status = 1` and only touch
  Fortellis/CDK-fed rows (`created_by` in `FORTELLIS_*`/`CDK_*`) — never manual vehicles.
- `created_by`: `FORTELLIS_BULK` (install/full-sync) / `FORTELLIS_DELTA` (hourly).

## Divergences from the CC prompt / spec (folded in)
1. **`scope=anonymous` required** on the token call.
2. **Real path is `/{ns}/sales/inventory/v2/merchandisable-vehicles`, synchronous** — not
   `/drive/…` async. `FORTELLIS_API_BASE=https://api.fortellis.io`, `FORTELLIS_ENV` selects
   `cdk` vs `cdk-test`.
3. **No Department-Id**; per-dealer scoping is `webId`/`dealerCode` → `fortellis_dealers` gains
   `web_id` + `dealer_code` columns (not `department_id`).
4. **API restricted + subscription inactive** → live vehicle calls can't be exercised until CDK
   activates the Test subscription/DMS sandbox. Token, subscriptions, UI, logging, cron
   plumbing, and alerting are all built and testable now; the vehicle path is built to the MVS2
   guide and flagged for a first-live-call sanity check (`mapVehicle` is the one place to tweak
   if a field name differs from the guide's example).
