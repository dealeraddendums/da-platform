# CLAUDE.md — DA Platform
> See `../CLAUDE.md` for shared infrastructure, design system, team, and architectural rules.
> This file covers da-platform specific context only.

---

## 🔴 ALL ACTIONS PRE-APPROVED — EXECUTE AUTONOMOUSLY

---

## Identity

**Repo:** `github.com/dealeraddendums/da-platform`
**URL:** https://app.dealeraddendums.com
**EC2:** `ec2-18-145-132-52.us-west-1.compute.amazonaws.com` (private IP: `172.31.23.99`)
**SSH:** `ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@ec2-18-145-132-52.us-west-1.compute.amazonaws.com`
**App path:** `/var/www/da-platform`
**PM2 service:** `da-platform` (port 3000)
**Supabase:** `https://byouefbebqgffhtfdggu.supabase.co`

### ⚠️ CRITICAL BUILD COMMAND
**Always use:** `./node_modules/.bin/next build`
**Never use:** `npx next build` — npx pulls Next 16 from npm instead of pinned local 14.2.35

**Deploy:** `git pull && npm ci && ./node_modules/.bin/next build && pm2 restart da-platform --update-env`
**Logs:** `/var/log/da-platform/`

### ⚠️ Auto-deploy on push to main
`.github/workflows/deploy.yml` SSHes to this EC2 on every push to `main` and runs `sudo rm -rf node_modules .next && npm install && npm run build && pm2 restart`. Concurrency lock (`group: deploy-production`, `cancel-in-progress: false`) added 2026-05-26 — without it, rapid pushes raced each other (and any manual SSH deploy in flight), producing SIGBUS/ENOENT mid-build and stripping `node_modules/.bin/`. **Do not run a manual SSH deploy while a workflow run is in flight.** Build runs with `NODE_OPTIONS=--max-old-space-size=2048` to bound peak heap on the 7.6 GB box.

**Legacy Platform EC2:** `ssh -i "~/ssh/DA2025.pem" ubuntu@ec2-52-22-32-67.compute-1.amazonaws.com`
**FTP Server EC2:** `ec2-34-193-4-78.compute-1.amazonaws.com` — Windows, Cerberus FTP Pro 12.8.0.0

## Stack

- Next.js 14.2.35 (App Router)
- Supabase (auth + all app data)
- Aurora MySQL (READ ONLY — dead code removed, never query)
- **da-pdf-service** microservice for Puppeteer rendering (Phase 10b — see section below). HTML→PDF for addendums/infosheets, pdf-lib FTC overlays for buyer's guides, S3 upload — all happens on `http://172.31.71.67:3001`. da-platform no longer depends on `puppeteer`.
- pdf-lib (used locally only for bulk buyer_guide branch overlay; the single buyers-guide route routes through the microservice)
- S3 `dealer-addendums` bucket (us-west-1, PDF storage, 24hr signed URLs)
- Mapbox GL JS (dealer map)
- Mandrill (transactional email)
- @simplewebauthn/server + browser v13 (passkey auth)
- Tiptap (rich text editor for product descriptions)
- ChromeData Media Gallery API (color-matched vehicle photos)
- ExcelJS (Excel generation/parsing — xlsx fully removed, HIGH vuln)

## Design System

```css
--navy:        #2a2b3c;
--orange:      #ffa500;
--blue:        #1976d2;
--blue-light:  #2196f3;
--success:     #4caf50;
--error:       #ff5252;
--bg-app:      #3a6897;
--bg-surface:  #ffffff;
--bg-subtle:   #f5f6f7;
--text-primary:   #333333;
--text-secondary: #55595c;
--text-muted:     #78828c;
--border:       #e0e0e0;
--border-strong:#c0c0c0;
```

- Font: Roboto only
- Cards: white bg, `1px #e0e0e0` border, `6px` radius, NO box-shadow
- Buttons: Primary `#1976d2`, Success `#4caf50`, Danger `#ff5252`, Orange `#ffa500`
- No gradients. No border-radius > 6px (pills at 20px OK). No animations > 150ms.

## Sidebar Navigation

**Dealer roles:** Dashboard → Products → Builder → Users → My Profile → Print Settings → [divider] → Order Supplies

**Super admin:** Dashboard → Dealers → Groups → Users → My Profile → [FEEDS] FTP Server / ETL Server / CDK Dealers / Tekion Dealers → [ADMIN] Reports / Billing / API Docs / Decoder / Documents / Buyer's Guide PDFs / Image Library

**Group admin:** Dashboard → My Group → Builder → [divider] → Order Supplies

## Terminology

All UI labels use **Products** not Options. **Bodystyle** not Style. Code identifiers, DB columns, routes unchanged.

## Role System

| Role | Access |
|---|---|
| `super_admin` | Full platform, impersonation, ghost mode |
| `group_admin` | Scoped to own group and member dealers |
| `dealer_admin` | Full access to own dealer |
| `dealer_user` | Read/print within own dealer |
| `dealer_restricted` | Same as dealer_user |

## Ghost Mode

- Dealer ghost: `POST /api/admin/ghost` with `{ dealer_id }` → orange banner
- Group ghost: `POST /api/admin/ghost` with `{ group_id }` → orange banner
- Builder in group ghost mode: reads/writes `group_templates`
- `ghostCtx.group_id` folded into Builder context
- All actions logged to `admin_audit`

## Critical Rules

### Aurora is Dead — Zero Queries
- `lib/aurora.ts` deleted May 2026 — do not recreate
- All production routes use Supabase only

### The Builder NEVER Prints
- Print flow: Inventory → Print button → intermediate screen → PDF server-side
- No print/PDF button in Builder UI ever

### Single Renderer Rule
- `renderW()` in `components/builder/widgetRenderer.ts` is the ONLY renderer
- Both canvas and PDF pipe through `renderW()`

### WYSIWYG Rule
- `applyVehicleDataToWidgets()` called on: init, switchPaperSize, template load

### PDF Naming
Per-vehicle PDFs are stored **flat at the bucket root, keyed by uppercased VIN**, and overwritten in place on reprint — no nested folders, no timestamps. Storage uppercases the VIN to match the dealer-website lookup in `lib/addendum.ts` (`checkPdfExists` HEADs `${BUCKET}/{VIN}.pdf`); S3 keys are case-sensitive so the two must agree. `buildPdfKey()` in `lib/s3-upload.ts` is the only place the per-vehicle key is built.
- Addendum: `{VIN}.pdf`
- Infosheet: `{VIN}_infosheet.pdf`
- Buyer's Guide: `{VIN}_buyers_guide.pdf` (Spanish: `{VIN}_buyers_guide_es.pdf`)
- Reprints overwrite the same key — never a new version/timestamp.
- Bulk combined: `{…}_bulk_{n}_{ts}.pdf` — merged print bundle, not a per-VIN file. Each vehicle in a bulk run is ALSO written to its `{VIN}.pdf` slot (parity with single print; see `app/api/pdf/bulk/route.ts` self-heal fallback).

## Product Rules Engine
- `applies_to = 'rules'` evaluated at addendum page load AND PDF generation
- Case-insensitive comparison always (`toUpperCase()`)
- Field order: Make → Model → Trim → Bodystyle

## Price Formatting
- All whole numbers → no decimals (`$499`, `$45,255`)
- Any cents → all show 2 decimals (`$499.00`, `$45,255.00`)
- `formatPriceSet()` utility in `lib/formatPrice.ts`

## Vehicle Fields — Hide If Empty
In `renderW()`, hide Color, Trim, Mileage when null/empty/zero.

## Product Descriptions — Tiptap
- Toolbar: collapsed, revealed with `A` toggle
- Bold, Italic, Underline, Bullets, Font size (8–20), Font color
- Line spacing stepper: 0.8–3.0, step 0.1, default 1.2
- Stored as HTML in `description` column
- Table preview strips HTML tags

## Builder — Dynamic Content Widgets

### Background Image, QR Code, VIN Barcode, Vehicle Photo
- Vehicle Photo: ChromeData Account ID `323951`, canvas `640`, PDF `1280`, default angle `03`

### Logo Widget
- Source of truth for the dealer's default logo is `dealers.logo_url` (NOT `dealer_settings`). The Settings UI writes here via `/api/dealers/[id]/logo`.
- The "Choose Logo Image" picker lists everything under `new-dealer-logos/{dealer_id}/` on S3. A picked image is persisted on the widget as `d.imgUrl`.
- **Fallback contract** — every render path (canvas via `applyLogoToWidgets` in `BuilderPage.tsx`, PDF via `app/api/pdf/generate/route.ts`, `app/api/pdf/bulk/route.ts`, and `lib/pdf-html.ts`) treats `imgUrl` as authoritative: if the widget already has a non-empty `imgUrl`, it wins. Only when the widget has no picked image do we fall back to `dealers.logo_url`. A Settings logo upload propagates to every template that hasn't been explicitly assigned a different logo.
- Do NOT strip `imgUrl` from logo widgets at save time or unconditionally override it at load time — both break the user's per-template selection.

### Disclaimer Widget
- Draggable onto canvas under STRUCTURAL section
- Renders all active disclaimers (group first, dealer second)
- No automatic PDF injection — only prints if widget placed
- Group admins place in group templates

### Auto-load Most Recent Template
- On blank `/builder` open, the page silently loads the dealer's most recently updated saved template (`/api/templates` sorted by `updated_at DESC`, dealer-owned rows preferred over assigned 🔒 group rows).
- Skipped when: `?template=` URL param is set (explicit nav wins), scoped to a group, vehicle-builder path (`/builder/[vehicleId]` has its own default-template resolution), or no dealer scope.
- A small "Editing: <name>" label sits next to the All Templates / Save Template buttons whenever a template is loaded.
- No auto-save — explicit Save Template still required.

### Inspector Panel Layout
Right-panel sections follow the same skeleton for every widget type (`WidgetEditPanel` in `components/builder/BuilderPage.tsx`):
1. Background Image (global; sits at the top of the scroll area above the widget header)
2. Widget header — widget name + position/size readout
3. Widget-specific settings (labels, toggles, colors, image picker, alignment, AI source, etc.)
4. Font Size — its own EpSection when the widget has any font controls (Vehicle, MSRP, Required/Suggested Products, Suggested Price, Subtotal, Asking Price, Dealer Address, Custom Text, Description, Features)
5. Line Spacing — its own EpSection (`LineSpacingStepper` for Required/Suggested Products tables, numeric input for Dealer Address / Custom Text)
6. Position & Size
7. Layer Order
8. Remove widget

When adding a new widget type, keep fonts and line spacing in the dedicated sections — do not inline them in the widget block.

### Backward Compatibility
Old `infobox` widgets auto-converted at template load time.

## Make / Model / Trim (NHTSA)
- 49 approved makes, `nhtsa_makes`/`nhtsa_models`/`nhtsa_trims` tables
- 498 trims seeded May 2026 via NHTSA batch decoder (FNV-1a int IDs match table PK)
- Trim coverage limited to most recent 1000 VINs — pagination fix needed for full coverage
- `GET /api/vehicles/makes`, `/api/vehicles/models?make_id=`, `/api/vehicles/trims?model_id=`
- Cron: `POST /api/cron/sync-vehicle-reference` → EasyCron `0 2 1 * *` ✅ live
- Trim harvest cron: `POST /api/cron/harvest-vin-trims` → EasyCron `0 3 * * *` ✅ live

## Addendum Disclaimer
```
THIS ADDENDUM HAS BEEN ADDED BY THE DEALER, NOT THE MANUFACTURER...
```
Baked into EPA/DOT background image.

## addendum_data Table (canonical)
3.9M+ rows. Three write sources: Legacy ETL daily, real-time `lib/syncAddendumItems.ts`, historical backfill (completed May 2026).

```sql
addendum_data (
  id uuid PRIMARY KEY,
  dealer_id uuid REFERENCES dealers(id),
  legacy_dealer_id text,
  vehicle_id uuid,
  legacy_vehicle_id integer,
  legacy_id integer,
  vin_number varchar,
  item_name text,
  item_description text,
  item_price varchar,
  required boolean,
  document_type text,
  printed_at timestamptz,
  s3_key text,
  created_at timestamptz,
  updated_at timestamptz,
  UNIQUE(dealer_id, legacy_id)
)
```

## Group Features

### Corporate Products
- `locked` boolean (default true) — locked = no remove button on dealer addendum
- `assign_all_dealers` boolean — new dealers auto-inherit
- Three-state badge: green "All Dealers", blue "N dealers", muted "Unassigned"
- Shows on dealer Products page with locked group banner ✅ working

### Group Disclaimers
- `locked` boolean (default true), STATE dropdown, "Save Disclaimer" button
- No automatic PDF injection — Disclaimer widget must be placed in template

### Group Templates
- Pointer row (`templates.group_template_id`) — never a copy
- Shows in dealer Builder with 🔒 Group badge, Load only, no Delete ✅ working
- `pdf/generate` resolves pointer → live `group_templates.template_data` at print time

### Group Controls Templates (per-dealer)
- `dealers.group_controls_templates` boolean (default false)
- When true AND `group_id IS NOT NULL`: Builder nav hidden for dealer, Print Settings template dropdowns read-only
- ⚠️ **Defensive rule:** always AND with `group_id IS NOT NULL` in gating checks (`layout.tsx`, `settings/page.tsx`, `builder/page.tsx`) — a stale `true` on a standalone dealer must never strip Builder access
- group_admin ghost mode: Builder always accessible
- `provisionDealer()` in QA setup route explicitly sets this flag on insert and re-run upserts: standalone dealers → `false`, grouped dealers → `true`

## Dealer Management

### Test Accounts
- `dealers.is_test` boolean — orange "TEST" pill
- Hard delete with name confirmation, logs to `admin_audit`

### Groups — Test Accounts  
- `groups.is_test` boolean — orange "TEST" pill
- Delete: disassociates member dealers, cascades templates/products/assignments

## First Login UX
Magic link invites → "Create Your Password" screen (min 8 chars). Applies to dealer + group admin invites.

## CDK Dealers (`/admin/cdk-dealers`)
- Fields: DEALER_NAME, DEALER_ID, ICOMPANY, NEW (boolean)
- Sort: NEW=Yes first, then alphabetical
- **Test:** `POST /api/admin/cdk/test` — verifies CDK connectivity
- **Import:** `POST /api/admin/cdk/import` — time window (2/7/30/90 days, custom), flips NEW=No on success
- **CDK Update:** orange button — bulk resync ALL dealers via SSE, time window selector, does NOT flip NEW
- **401 handling:** log immediately, 30s timeout per dealer, email to `support@dealeraddendums.com`
- **Remove All 401 Dealers:** batch delete in error summary
- Exclude test/allan dealers

**CDK API:**
```
POST https://3pa.dmotorworks.com/pip-extract/inventoryvehicleext/extract
Params: qparamInvCompany, dealerId, queryId=IVEH_Bulk, deltaDate (optional)
Auth: Basic — CDK_API_USERNAME / CDK_API_PASSWORD in .env.production
```

## Tekion Dealers (`/admin/tekion-dealers`)
Simple CRUD — DEALER_NAME, DEALER_ID only.

## FTP Server (`/admin/ftp-server`)

### Architecture
- Cerberus FTP Pro 12.8.0.0 on Windows EC2 `34.193.4.78`
- SOAP API requires gSOAP HTTP Basic Auth challenge-response (PHP handles automatically)
- **Solution:** PHP proxy at `/var/www/cerberus/proxy.php` on DA Platform EC2
- nginx serves at `http://localhost/cerberus-proxy/proxy.php` (localhost only)
- `lib/cerberus.ts` calls localhost proxy
- Hub server (`52.22.32.67`) being decommissioned — proxy is self-contained

### Proxy details
- WSDL: `/var/www/cerberus/Cerberus.wsdl.xml`
- Proxy secret: env `CERBERUS_PROXY_SECRET` (in nginx fastcgi_param)
- FTP credentials: `CERBERUS_FTP_USER` / `CERBERUS_FTP_PASS` (nginx fastcgi_param — NOT in repo)
- `allantone` FTP account used for file browser (full `C:\ftproot\` access)

### Supported SOAP actions
`GetUserList`, `GetUserInformation`, `AddUser`, `DeleteUser`, `ChangePassword`

### File browser actions (via FTP)
`list_files`, `download_file`, `delete_file`, `upload_file`
- Upload limit: 100MB (nginx `client_max_body_size 100m`, PHP `/etc/php/8.3/fpm/php.ini`)
- Path traversal rejected, `.` and `..` filtered

### FTP root
`C:\ftproot\{username}\` — folder name = username

### AWS Security Group (FTP EC2)
| Port | Source | Purpose |
|---|---|---|
| 21 | `0.0.0.0/0` | FTP dealers |
| 22 | `0.0.0.0/0` | SFTP dealers |
| 990 | `0.0.0.0/0` | FTPS dealers |
| 49152-65535 | `0.0.0.0/0` | FTP passive |
| 10001 | `18.145.132.52/32` | SOAP — DA Platform only |
| 10001 | `52.22.32.67/32` | SOAP — Hub only |
| 8443 | `18.145.132.52/32` | Cerberus web admin |
| 3389 | `34.202.235.98/32` | RDP — VPN only |

## ChromeData Monthly Usage Report
- Cron: `POST /api/cron/chromedata-usage-report` → EasyCron `0 9 5 * *` ✅ live
- Qualifies: active paid dealers, vehicle_photo widget in template, >10 prints previous month
- Contract #9310, email to `billing@chromedata.com`
- S3: `dealer-addendums/chromedata-reports/ChromeData_Usage_{YYYY}_{MM}.xlsx`
- Now uses ExcelJS — verify format on Reports page before next automated send

## Manual Vehicle Sync
- Backfill script: `scripts/backfill-manual-vehicles.js` — EXCEL/APP/VIN API vehicles, 18 months
- Run in tmux: `tmux new-session -d -s manual-backfill 'node /var/www/da-platform/scripts/backfill-manual-vehicles.js 2>&1 | tee /tmp/backfill-manual-vehicles.log'`
- ETL2 handles regular inventory sync to both platforms
- After backfill: only new manually-added vehicles need ongoing sync (last 24hrs)
- `ON CONFLICT DO NOTHING` — never overwrite

## Phase 10 — Billing Integration ✅ Complete

### da-billing API
- **Base URL:** `https://billing.dealeraddendums.com/api/v1`
- **Auth:** `X-API-Key: dab_b1ce5e7768aef3f94e652a69303f3ecce44f487244824e96562c9d0704b58a7f`
- All calls non-blocking — errors logged to `billing_sync_errors` table
- **Pay button URL rewrite:** da-billing returns `paymentUrl` bound to its own runtime host (`http://localhost:3009` when serving itself on prod). `listInvoices()` in `lib/billing.ts` rebuilds the URL as `${BILLING_PUBLIC_URL}${pathname}${search}${hash}` before exposing it to the browser. `BILLING_PUBLIC_URL` env var, default `https://billing.dealeraddendums.com`. Do NOT mutate `u.host` — the WHATWG URL host setter keeps the existing port when the new value has no colon.

### XPS Shipper
- **API Key:** `Jx5vg3PLLL0HGCQV4YAyIuHdAMf0sXKb`
- **Customer ID:** `12302875`
- **Integration ID:** `91819`

### Group billing scenarios
| Scenario | Subscription | Labels |
|---|---|---|
| A | Dealer pays | Dealer pays |
| B | Group pays | Dealer pays |
| C | Group pays | Group pays |

### Dealer lifecycle events → da-billing
- New dealer created → `POST /api/v1/customers` + `POST /api/v1/templates`
- Subscription changed → `PUT /api/v1/templates/:customerId`
- Dealer added to group → update billing config per scenario
- Dealer removed from group → revert to dealer-pays-everything
- Dealer deactivated → archive in da-billing

### Billing Tab — Plan Name Mapping
The Current Subscription card PLAN field maps da-billing product type → display name:
- Contains "Manual" → `"Manual"`
- Contains "Automatic Web" or "AutomaticWeb" → `"Automatic Web"`
- Contains "Automatic DMS" or "AutomaticDMS" → `"Automatic DMS"`

### Label orders
- **Both `dealer_admin` and `dealer_user` can place label orders** — `dealer_restricted` cannot
- `canEdit` (profile/shipping) is separate from `canOrderLabels` (label orders) in `app/(dashboard)/profile/page.tsx` — dealer_user can order but cannot edit dealer profile or shipping address
- Label orders require an active da-billing template on the dealer — without one the API returns 403 "not available on your current plan" regardless of role
- **Recommended label size feature:** Order Labels tab detects dealer's active addendum template(s) from `dealer_settings.default_addendum_new` / `default_addendum_used`, reads `template_json.paperSize`, and highlights matching label SKU cards with an orange `#ffa500` "Recommended" pill + border. Tip banner shown below grid. Silent fallback if no template assigned. Never disables ordering. Mixed sizes (new/used templates differ) shows both in tip.
  - `paperSize: "standard"` → 4.25" cards (8300-1, 9300-1)
  - `paperSize: "narrow"` → 3.125" cards (8300-3, 9300-3)
  - `paperSize: "full"` → 8.5" cards (8300, 9300)
- Creates XPS shipping order + da-billing template line item
- Stored in `label_orders` Supabase table
- **Tracking:** XPS pushes tracking updates via webhook to `POST /api/webhooks/xps` — correlates by `orderId`, updates `xps_status` / `xps_tracking_number` / `xps_carrier` on `label_orders`
- **xps_webhook_log table** — every raw XPS webhook payload logged here; use this to debug unexpected field names before touching the parser
- **Webhook parser** handles multiple payload shapes: `orderId`/`orderNumber`/`shipperReference`, top-level vs nested under `shipment`, `trackingNumber` vs `trackingNumbers[0]`
- **Carrier tracking URLs** — Orders tab uses carrier-specific URLs (USPS/UPS/FedEx/DHL), not Google search links
- **Old polling cron retired** — `POST /api/cron/sync-xps-tracking` is now a no-op; EasyCron job 11088481 ("XPS Tracking", `0 10 * * *`) safe to delete once first real webhook fires and confirms tracking lands correctly
- **XPS webhook endpoints:**
  - `GET /api/webhooks/xps/orders` — List Orders stub (always returns `{"orders":[]}`, required by XPS to save integration config; we push orders via REST at order time so this is always empty)
  - `POST /api/webhooks/xps` — Update Order receiver (tracking numbers, shipment status)
- **XPS integration config:** List Orders URL → `/api/webhooks/xps/orders`, Update Order URL → `/api/webhooks/xps`, Secret Key in `XPS_WEBHOOK_SECRET` env var
- Both endpoints validate `XPS_WEBHOOK_SECRET`, log to `xps_webhook_log`
- **Fulfillment workflow:** DA Platform creates XPS order → Virginia sees it in her XPS queue → she packs and prints the label in XPS → tracking number generated at that point → daily cron pulls tracking and updates the order. No tracking number at order time is correct and expected.
- **Billing is DA-internal only** — dealers never see billing status on label orders. All billing status indicators hidden from dealer-facing UI. Only super-admin views may show billing status.
- **XPS payload spec (per line item):**
  - `quantity: 1` always — one shipment per SKU line, never the label count
  - `title: "{Product Name} x{labelCount}"` e.g. "Regular Addendums x2000"
  - `unitPrice: orderLineTotal` — the total price for that SKU+quantity combination
  - `weight: 0` on the line item — package-level weight is set separately from `lib/label-weights.ts` (flat per-SKU, summed for mixed carts)
  - Mixed carts: one line item per SKU, package weight = sum of all SKU weights
- Billing routing: `labels_billed_to = 'group'` → append to group template; `labels_billed_to = 'dealer'` with active template → append to dealer template; `labels_billed_to = 'dealer'` + group but no template → one-time invoice; Free/Trial + no group → blocked with upgrade message
- Free/Trial dealers see upgrade notice, Place Order hidden
- Label line item format: `{internal_id}::{name}::{sku}` (SKU appended for uniqueness on multi-SKU orders)

### SKU → da-billing labelType mapping
DA Platform sends `labelType` slug (not price) — da-billing resolves price from its own matrix:

| SKU | Product Name | da-billing labelType |
|---|---|---|
| `8300-1` | Regular Addendums | `4.25x11-standard` |
| `9300-1` | Regular Addendums — Waterproof | `4.25x11-waterproof` |
| `8300-3` | Narrow Addendums | `3.125x11-standard` |
| `9300-3` | Narrow Addendums — Waterproof | `3.125x11-waterproof` |
| `8300` | Full Sheet Labels | `8.5x11-standard` |
| `9300` | Full Sheet Labels — Waterproof | `8.5x11-waterproof` |

Mapping lives in `app/api/orders/labels/route.ts` as `SKU_TO_LABEL_TYPE`. Must stay in sync with da-billing's `src/lib/label-pricing.ts`.

### XPS Shipper credentials
- API Key: `Jx5vg3PLLLOHGCQV4YAyIuHdAMfOsXKb` (capital O, not zero)
- Customer ID: `12302875`
- Integration ID: `91819`
- Sender phone: `8014159435`
- Sender address: `277 E 4600 S, Murray, UT 84107`
- Env vars: `XPS_API_KEY`, `XPS_CUSTOMER_ID`, `XPS_INTEGRATION_ID`, `XPS_SENDER_*`

### Group assignment (Super Admin)
Super Admin can assign an existing standalone dealer to a group from the dealer profile page:
- DA Group dropdown appears when editing dealer profile
- Subscription Billed To + Labels Billed To fields shown on group selection
- Defaults: Group/Group, Controls Templates ON
- Triggers full billing cascade: template cleanup, group template update, discount sync
- Cascade in `lib/group-billing-cascade.ts`

### Auto group discount
- Tier rules in `lib/group-discount.ts`: 0-1 dealers=0%, 2-10=10%, 11-30=20%, >30=30%
- Fires on: dealer added to group, dealer removed, dealer deactivated
- Respects `discountLocked` flag on da-billing customer — if locked, never auto-update
- `lib/sync-group-discount.ts` → `fireGroupDiscountSync(groupId)`

## Migration Status

Current highest migration: **092**

Recent migrations:
- 071 `dealer_inventory_provider` — track CDK/Tekion/manual feed source per dealer
- 072 `box_folder_id` — auto-provision a Box.com folder per dealer + per group

### Box Folder Provisioning (lib/box.ts)
- **Root folder:** `384943909938` (`BOX_ROOT_FOLDER_ID`) — Allan's "DealerAddendums Platform" folder at `box.com/folder/384943909938`
- **Service account:** `AutomationUser_2577618_5z5oxVB2bn@boxdevedition.com` (Box user id `51252734058`) — Co-Owner on root; all folders owned by `allan@allantone.com`
- **Hierarchy:** `DealerAddendums Platform → Dealers/{dealer_name}` and `DealerAddendums Platform → Groups/{group_name}`
- **Parents** ("Dealers", "Groups") lazily created on first use via `ensureParentFolder()`; `createOrReuseChild()` handles 409 conflicts via `responseInfo.body.context_info.conflicts[0].id`
- ⚠️ **SDK history:** `box-node-sdk` bumped to v10.10.0 on 2026-05-25 broke v3 API. Fixed commit fd451f3 to v10: `JwtConfig.fromConfigJsonString` → `BoxJwtAuth` → `BoxClient`; `folders.create` → `folders.createFolder`; `folders.getItems` → `folders.getFolderItems({ queryParams: {...} })`
- ⚠️ **Root history:** Original `BOX_ROOT_FOLDER_ID="0"` created folders under service account root (invisible to Allan). Fixed commit f619ab4 to `384943909938`
- **QA folder IDs:** QA Test Group → `384945602222`, QA Test Dealer A → `384943614967`, QA Test Dealer B → `384935891285`
- 073 `qa_help_center` — QA portal help-center tables
- 074 `qa_test_environment` — `/qa` + `/qa/test` QA portal (dealer_admin + dealer_user accounts)
- 075 `qa_test_items_backfill` — backfill `qa_test_items` rows; companion to 074
- 076 `invitations_unique_indexes` — unique indexes on invitations table
- 077 `invitations_unique_indexes_non_partial` — revised non-partial unique indexes on invitations (supersedes 076)
- 078 `qa_test_items_email_fix` — idempotent UPDATE fixing truncated `@test` → `@test.dealeraddendums.com` in `qa_test_items.steps`; migrations 074+075 also corrected in source
- 079–081 — (check repo for details; added during QA session 2026-05-28)
- 082 `hubspot_sync_errors` — Phase 14 sync error log
- 083 `dealers_downgraded_inactivated` — `downgraded_at` / archive columns (self-close + Downgraded lifecycle)
- 084 `dealer_custom_sizes_doc_type` — landscape / custom-size `doc_type`
- 085 `account_closures` — dealer self-close reason log
- 086 `label_orders_ordered_by_name` — snapshot of who placed each label order
- 087 `self_serve_acquisition` — self-serve signup: dealer acquisition/attribution columns (utm/gclid/referrer/landing) + `POST /api/self-serve/signup`
- 088 `lock_team_super_admin` — `enforce_team_super_admin()` BEFORE INSERT/UPDATE trigger on `profiles` pins `allan/alex/claire/marlena/carol@dealeraddendums.com` to `super_admin` regardless of writer (ETL-proof). To change the team list, edit the email array via a new migration.
- 089 `invitation_setup_codes` — `setup_code_hash` + `setup_code_expires_at` on `invitations` (scanner-proof typed-code invite acceptance)
- 090 `image_library_scope` — `scope` ('platform'|'group'|'dealer') + `group_id` + `dealer_id` on `image_library` (dealer/group/platform-scoped Builder images; RLS read = platform OR own-group OR own-dealer, write role-bounded)
- 091 `help_articles` — dedicated dealer-help CMS (articles + RLS; rich text/graphics/video; separate from `qa_help_center`); + `/help` render, TipTap authoring, image/video upload
- 092 `help_conversations` — Help assistant conversation + message log (`+ help_messages`, feedback, status, `hubspot_note_id`, `escalation_notified_at`; RLS owner-read / super_admin-all) for the global Help/Support widget


## 2026-06-05 — Session shipped (features + fixes)

Specs in `docs/`; all verified by Claude Code. Commits `8e9a93b` (ETL) · `ca65353` + `3354daa` (invite/auth) · `9b2d052` (scoped images) · `ec3f379` (spinner) · `313d9fc` (template-save) · legal `54922b6`/`45282be`/`77da13b`.

### Dealer/group-scoped Builder images (`docs/builder-scoped-images.md`) — migration 090
- `image_library` gained `scope` ('platform'|'group'|'dealer') + `group_id` + `dealer_id`. The "Choose Background" picker shows **Platform** / **{Group} Library** / **My Images**; scope-aware Upload for dealer_admin + group_admin; per-image delete limited to the caller's scope; scoped S3 key prefixes; enforced on the API (`getJwtClaims`) **and** RLS. New Group Image Library panel on the group page. Commit `9b2d052`.

### Legal pages — Terms of Use + Privacy Policy (`docs/legal/*.md`, `docs/legal-pages-styling.md`)
- Rewritten for the current platform; public `/terms` + `/privacy` on DA Platform (`54922b6`) and the marketing site (`45282be`/`77da13b`), rendered from **byte-identical** markdown (re-sync on any edit). Branded `LegalShell` (login logo + gradient + white sheet) with a **Download PDF** (print-to-PDF). Entity **DealerAddendums LLC**, governing law **Delaware**, contact **support@dealeraddendums.com** only; includes a "we do not access customer / sale / card data" clause + named sub-processors. **Pending:** legal-counsel review + marketing DNS cutover (`dealeraddendums.com/terms` goes live at cutover).

### Builder Position & Size spinner fix (`ec3f379`)
- X/Y/W/H number inputs set `step={SNAP}` (4px grid) + `min`; the spinner arrows now move the widget one grid cell (a default +1 step previously snapped right back via `snapV`).

### group_admin template-save — active-dealer (`docs/group-admin-template-save.md`, `313d9fc`)
- `resolveDealerId` (`app/api/templates/route.ts`) + `/api/settings` now honor a group_admin's **active dealer** (`claims.dealer_id`, with a defensive `group_id` re-check) instead of 400ing on a missing `?dealer_id`; the Builder save also passes the param. `PATCH /api/templates/[id]` already authorized via `fetchAndAuthorize` and was left unchanged. A group_admin switched into a member dealer can now Save a dealer template and set its default. Same active-dealer-context theme as `group-admin-active-dealer-scoping.md` (Dashboard/Products).

### DA Legacy ETL — Profiles job is now a no-op (`da-legacy-etl/docs/profiles-no-overwrite.md`)
- The daily Profiles job (Job 3) upserted `role` by email; `mapRole` only knew Aurora `GroupAdmin`, so `RootAdmin`/`DealerAdmin`/`DealerAdminRestricted` all collapsed to `dealer_user` — silently demoting anyone promoted in Supabase. Job is now a **no-op** (Supabase = source of truth for profiles; it can't create profiles anyway — `profiles.id` = auth UUID, ETL must never create auth users). `mapRole` corrected but **inert** while the job is a no-op. Audit: ~2,174 profiles sat above the broken map, but the app resolves `profiles.role` **by auth UUID**, so demotions only bit single-row users — only Robert confirmed; the 4 team super_admins were already protected by the migration-088 trigger.

### Group bill-to — one-time backfill (`docs/group-billing-backfill.md`)
- App reads migration-067 `dealers.subscription_billed_to` / `labels_billed_to` (default `'dealer'`); 067 never backfilled them and the ETL syncs no bill-to → every group dealer showed Dealer/Dealer. Backfilled **856 group dealers** from Aurora `dealer_dim.SUB_BILLING_TO` (subscription) / `BILLING_TO` (labels), `group_id IS NOT NULL` only. **Not** added to the ETL (one-time; new platform is source of truth). **Deferred — Step 3:** 128 group-billed groups still lack `groups.billing_customer_id` (only 2 have one); until created, group-billed charges rely on the lazy create-on-next-event path in `lib/group-billing-cascade.ts`.

### Group member table + Users tab (`docs/group-member-table-ux.md`, `docs/user-invite-feedback.md`)
- Member Dealers list sortable + searchable by Name / Dealer ID / Inventory Dealer ID (client-side); the Users/Billing/Corporate Products/Disclaimers/Templates tabs render **above** the member list. Group/dealer Users tabs now show an "invitation sent" toast + a **Pending Invitations** section (resend/revoke).

### "Last sign in" fix (`docs/invite-auth-and-last-signin.md` Part B)
- `auth` schema isn't exposed to PostgREST, so `admin.schema("auth").from("users")` returned nothing → every row showed "Never." New `lib/last-sign-in.ts` (`lastSignInByEmail()`, paginates the GoTrue admin API, 60s cache); group Users + all 3 branches of `/api/users` resolve last-sign-in **by email**.

### Scanner-proof invite acceptance (`docs/scanner-proof-invite.md`, `docs/invite-auth-and-last-signin.md` Part A)
- The invite email led with a clickable link and the passwordless branch consumed the invitation at code-**send** time → dealership **Barracuda** link-scanners (empty-UA HEAD+GET on the invite URL, confirmed in access logs) consumed invites before the human → "Invitation already accepted." Migration **089** + `lib/invite-code.ts` (8-digit, SHA-256, constant-time) + `lib/invite-email.ts` (email **leads with the code**; link inert). `/api/invite/accept` rewritten to consume the invitation **only on a human action** (code-verify or password-submit), set `app_metadata.role`, resolve the auth user idempotently; `/api/invite/resend` is non-consuming. `/signup?invite=` is a state machine: choose → code | password → passkey (skippable, explainer) → dashboard. Dealer chooses **code or password**; passkey never required. (Password path signs in with `signInWithPassword`; code path issues its magic-link token last so setting the password can't invalidate it — the 3354daa fix.)


## 2026-06-02 — Session shipped (features + fixes)

Specs in `docs/` (`_build-queue.md` indexes them); all verified by Claude Code. Commit refs to be backfilled.

### Account lifecycle + print-eligibility (`docs/print-eligibility-free-expired.md`, `docs/dealer-self-close-account.md`)
- **States:** **Trial** = default for new dealers (allowance 30 days OR 30 lifetime prints since `created_at`; over → Trial Expired) · **Paid** (always prints) · **Free/Downgraded** = reached ONLY by downgrading from paid; can log in but cannot print; 60-day grace then archived. "Free Expired" folds into Downgraded — no separate HubSpot stage.
- **`lib/print-eligibility.ts`** is the single source of truth: `canPrint`, `isOverAllowance` (30d OR 30 prints), `enforceCanPrint` (super_admin bypasses). 403-enforced in all four print routes (`api/pdf/generate`, `api/pdf/bulk`, `api/print/bulk`, `api/print/[vehicleId]`); inventory Print buttons disable + tooltip when blocked. The SAME `isOverAllowance` drives the HubSpot lifecycle derivation in `lib/sync-hubspot.ts`.
- **Past-due billing lock (2026-06-07, `docs/past-due-print-lock.md`)** — `canPrintForDealer` stacks a past-due check on top of the Trial/Free gate: it resolves the **responsible payer** (group-billed dealer `subscription_billed_to='group'` → the **group's** da-billing customer; else the dealer's own `billing_customer_id`) and blocks when that customer is past due per da-billing `GET /customers/:id/billing-status` (an unpaid invoice older than the customer's **Overdue Days** grace — default 37, Dealer General 10). 20-min in-memory cache (`getBillingStatus` in `lib/billing.ts`); **fails open** (allows) on any da-billing error or unresolvable customer — never block a paying dealer on a service hiccup; super_admin bypasses. Tooltip varies by payer via `billedBy` on the gate result: group-billed → *"Printing is paused. To restore it, please contact your Group Administrator."*; self-billed → *"Printing is temporarily disabled due to a past-due invoice."* (a self-billed dealer that sits in a group still gets the self-billed copy — keyed off `subscription_billed_to`, not group membership). Single-instance prod (Puppeteer offloaded to da-pdf-service), so the in-memory cache is process-coherent.
  - **Cache-bust webhook:** `POST /api/billing-cache/invalidate` (header `X-Webhook-Secret` = `BILLING_CACHE_WEBHOOK_SECRET`, body `{customerId}` or none → clear all) lets da-billing invalidate the cached status the moment Overdue Days changes or an invoice is paid/voided, so the lock reflects immediately instead of waiting out the TTL (the TTL is the backstop). Env on da-platform: **`BILLING_CACHE_WEBHOOK_SECRET`** (`.env.production`). da-billing side fires it — see `CLAUDE-da-billing.md`.
- **Dealer self-close** `POST /api/billing/me/close`: $0-balance gate (409 `balance_due`) → `deleteTemplate` stops recurring billing now (NOT `archiveCustomer`) → `account_type='Free'` + `downgraded_at`, stays `active` → `account_closures` row → HubSpot Downgraded via `fireDealerReliable`. Migration `085`. "Free — $0/mo" option in the BillingTab plan picker. Re-open = re-subscribe (`/api/billing/me/subscription` PATCH); +60-day archive = existing `archive-downgraded` cron.

### Group-ghost scoping fix (`docs/group-ghost-dashboard-dealers-scoping.md`)
`dashboard/page.tsx` + `dealers/page.tsx` now route a super_admin group-ghost (`ghostCtx.group_id`, no `dealer_text_id`) into the existing `group_admin` branches — "ghost as group" shows the group's dealers/stats/map/activity, not platform-wide. Real group_admin logins were already correct.

### Builder — Custom Size for dealers (`docs/builder-custom-size-for-dealers.md`)
`builder/page.tsx` `canAddCustomSize` is now `super_admin || dealer_admin` (the API `POST /api/custom-sizes` already permitted dealer_admin; it was only a UI gate).

### Product names — safe rich text + images (`docs/product-image-names.md`)
Names render through a sanitized **`<RichName>`** renderer (`lib/product-name.tsx`): inline styling (`<span style="color">`, b/i/u…) renders, embedded `<img>` shows a size-constrained thumbnail + alt/filename label, dangerous HTML stripped. Image insert now writes an `alt`. **Descriptions routed through the same sanitizer** (new HTML-sanitizer dependency). Sites: options table, Add-from-Library modal, AddendumEditor, + a preview under the Configure Product ITEM NAME input.

### Smaller items
- **Order history "Ordered By"** (`docs/order-history-ordered-by.md`): migration `086` adds `label_orders.ordered_by_name`; POST persists, GET selects, new column on My Profile → Orders.
- **Graphical printer-nudge** (`docs/printer-nudge-graphical.md`): `SettingsForm.tsx` Printer Nudge Margins → arrow-pad + live page preview; `nudge_*` data/save unchanged.
- **Tire loader** (`docs/multi-print-tire-loader.md`): `PdfBuildingOverlay.tsx` uses `public/datire_loader.svg` (self-animating SMIL) for the multi-print overlay.
- **Walkthrough tweaks #1–#4** (`docs/team-walkthrough-tweaks.md`): lock-icon tooltip; bulk Clear Print History (now in `ManualVehicleInventory.tsx`); readable dealer-profile header buttons; consistent blue/white Configure-Product toggles.

## QA Bug Fix History

### Custom Group Discount Overwritten by Sync (2026-05-28, commits a9d6c15 + 97ddc96)
When a dealer was removed from a group, da-platform recalculated the auto-tier discount and synced it to da-billing, overwriting manually set custom discounts. Custom discounts are any value not in {0, 10, 20, 30}.

Two-layer fix — either layer alone fixes the bug; together they survive a stale deploy on either side:
- **da-platform** (`lib/sync-group-discount.ts`): before syncing, fetch current customer discount. If not in {0, 10, 20, 30}, log "custom subscriptionDiscount" and skip sync entirely. Sync PUTs carry header `X-DA-Auto-Tier-Sync: 1`.
- **da-billing** (`PUT /customers/:id`): when request carries `X-DA-Auto-Tier-Sync: 1` and body includes `subscriptionDiscount` and existing value is not in {0, 10, 20, 30} → strip `subscriptionDiscount` from merge, log dropped attempt.
- Operator UI PUTs carry no header → retain full control including walking custom values back to auto-tier
- Existing `discountLocked` flag still short-circuits before either new check

**Rule: custom discount = any value not in {0, 10, 20, 30}. Never auto-overwrite these.**

### Builder Missing for dealer_admin / group_controls_templates (2026-05-28)
`group_controls_templates=true` was stale on QA Test Dealer A (standalone dealer), hiding Builder nav and locking Print Settings. Root cause: flag was set without enforcing `group_id IS NOT NULL`. Fix: all gating in `layout.tsx`, `settings/page.tsx`, `builder/page.tsx` now ANDs with `group_id IS NOT NULL`. QA setup route `provisionDealer()` now explicitly sets the flag on every insert and re-run. Nav order also corrected: Dashboard → Products → Builder → Users → My Profile → Print Settings → [divider] → Order Supplies → Help.

### Invite Flow (2026-05-27, commits abd3802 + 4f8f633)
Three bugs: (1) Email logo 403 — old S3 URL dead, fixed to `${NEXT_PUBLIC_APP_URL}/images/da-logo.png` in 5 files. (2) Accept Invitation two-layer failure — GET wrapped in `{ data: {} }`; POST swapped `.insert()` to `.upsert({ onConflict: "id" })` because `handle_new_user` trigger auto-inserts a minimal profile row on every `auth.users` INSERT — **permanent rule: always upsert profiles, never insert after auth user creation**. (3) `+ Invite User` button used `btn-secondary` on `--bg-app` blue — changed to `btn-primary`. **Rule: never use `btn-secondary` on `--bg-app` backgrounds.**

### QA Profile Binding (2026-05-27, commit f44dd1f)
`profiles.dealer_id` is TEXT joining on `dealers.dealer_id` (e.g. `qa-test-dealer-a`) — NOT the UUID from `dealers.id`. Setup route was assigning the UUID. Fixed + post-loop resync pass added. QA Test Dealer A: `dealer_id=qa-test-dealer-a`, `id=49080658-bc91-4697-9696-a158b22ba9f4`. QA Test Group: `id=3559642e-58ef-4f85-b71a-4b4016f4918b`.

### QA Email Truncation (2026-05-27, commit f596897)
All 20 `@test` strings in migrations 074+075 seed data truncated the domain. Fixed in source + migration 078 patches live rows. Full addresses: `qa-dealer-admin@test.dealeraddendums.com`, `qa-dealer-user@test.dealeraddendums.com`, `qa-dealer-restricted@test.dealeraddendums.com`, `qa-group-admin@test.dealeraddendums.com`. Password: `QATest2026!`

## Phase Status

| Phase | Name | Status |
|---|---|---|
| 1–9b | All prior phases | ✅ Complete |
| 10 | Billing Integration | ✅ Complete |
| 10b | PDF Microservice | ✅ Complete — all phases shipped, puppeteer removed from da-platform |
| 11 | Admin Ops | ⬜ Deferred |
| 12 | Enterprise White Label | ⬜ Queued |
| 13 | Dealer Self-Serve Onboarding | ⬜ Queued |
| 14 | HubSpot Sync (DA → HubSpot, one-way) | ✅ Complete — write path + daily cron live, backfill 100%, EasyCron registered + green |
| 15 | iOS & Android Apps | ⬜ Queued |

## Phase 10b — PDF Microservice (✅ Complete, fully cut over)

### Current Status — updated 2026-05-30

**All HTML→PDF rendering runs on the PDF microservice at `http://172.31.71.67:3001`.** The `puppeteer` dependency has been removed from `da-platform`, `lib/pdf-renderer.ts` has been deleted, and the routes no longer carry a local fallback. The bulk route's `buyer_guide` branch is the only remaining local PDF work — it uses `pdf-lib` (no Puppeteer) to overlay FTC backgrounds and that's left as-is.

**The user-visible flow (Print Now on a vehicle):**
1. Modal opens with a spinner ("Rendering… → Almost ready… → Finalizing…").
2. da-platform POSTs `/api/pdf/generate?async=1` with the assembled HTML; the service enqueues and returns `{ jobId, statusUrl, s3Key }`.
3. Browser polls `GET /api/pdf/status/:jobId` (da-platform proxies to the service so the private IP stays internal).
4. Service renders via Puppeteer, uploads to the canonical `s3Key` in `dealer-addendums` (us-west-1), responds `complete` with a 15-minute pre-signed URL.
5. Modal swaps the spinner for an iframe loaded directly from the signed URL. Print Send-to-Printer also uses that URL.
6. da-platform's route ran `awaitJobAndFetch(jobId)` in fire-and-forget alongside the async response, so `print_history` / `dealer_vehicles` print flags / `vehicle_audit_log` still land via the existing `logGeneratePdf` pipeline.

**Hard requirement post-cutover:** `PDF_SERVICE_URL` + `PDF_SERVICE_API_KEY` must be set in da-platform's env. `useService()` in `lib/pdf-service-client.ts` returns false when either is missing AND `USE_PDF_SERVICE` isn't `1`, in which case the routes 503 — there's no local Puppeteer to fall back to anymore. To roll back to local rendering you'd have to `git revert` and `npm install puppeteer` again (no flag flip).

**Client contract** (`lib/pdf-service-client.ts`):
- Base `PDF_SERVICE_URL`; auth header `X-API-Key: $PDF_SERVICE_API_KEY`.
- Service endpoints (all gated by `X-API-Key`):
  - `POST /api/pdf/generate` — body `{ html, paperSize?, customDims?, allPages?, s3Key? }` → `{ jobId }`.
  - `POST /api/pdf/bulk` — body `{ jobs: [{ html, paperSize?, customDims?, s3Key? }], s3Key? }` → `{ jobId }`. The service uploads each per-vehicle PDF to its `s3Key` plus a merged PDF to the top-level `s3Key`, and surfaces per-item `items[]` of `{ s3Key, signedUrl }` in the status response so da-platform can write `print_history.pdf_url` for each vehicle without re-uploading anything.
  - `POST /api/pdf/buyer-guide` — body `{ srcPdfBase64, input, s3Key? }`. da-platform pre-fetches the FTC background from Supabase Storage and ships the bytes so the service stays Supabase-free.
  - `GET /api/pdf/status/:jobId` — `{ status: "pending"|"running"|"complete"|"failed", s3Key, signedUrl, items?, error? }`.
- Async flow: enqueue returns `{ jobId }` immediately; poll interval 1s, timeout 120s (covers a ~200-vehicle bulk).

### Per-vehicle `{VIN}.pdf` storage fix — 2026-05-30
Bulk wasn't saving individual per-vehicle PDFs to S3 (single prints were fine). Two causes, both resolved by **deploy + a key-format change — no new service logic**. Runbook: `docs/pdf-vin-fix-deploy-task.md`.
- **Flat key.** `buildPdfKey()` (`lib/s3-upload.ts`) now writes per-vehicle PDFs as flat, uppercased `{VIN}.pdf` (was nested `{internal_id}/{vehicle_uuid}/{VIN}.pdf`). Matches the dealer-website lookup in `lib/addendum.ts` (`checkPdfExists` HEADs `${BUCKET}/{VIN}.pdf`) and makes VIN-prefix bucket search work. Reprints overwrite in place; infosheet/buyer-guide keep VIN-prefixed suffixes (`{VIN}_infosheet.pdf`, `{VIN}_buyers_guide.pdf`).
- **Bulk self-heal.** `app/api/pdf/bulk/route.ts` now splits the merged PDF and uploads each `{VIN}.pdf` itself when the service returns no per-item signed URL (parity with single-print's re-upload). Auto-disables once the service uploads per-item.
- **Deploy gap.** da-pdf-service `503fd5c` (per-item `s3Key` upload + `items[]` in status) is committed but da-pdf-service has **no auto-deploy** — confirm the EC2 is past `503fd5c` (`git log` + `pm2 restart da-pdf-service`).

### EOD 2026-05-30 — verification + open follow-ups

Today's deploys are live and verified end-to-end. Resume points for tomorrow are below.

**Verified on prod (3-vehicle bulk from `qa-dealer-admin`):**
- `fc6872f` shipped on da-platform via GitHub Actions auto-deploy.
- `503fd5c` confirmed already running on the PDF EC2 (`git log` matches; `pm2 list` shows ~3h uptime; no restart needed).
- All three new per-vehicle PDFs landed at flat `{VIN}.pdf` keys (`QATESTVIN0000001.pdf` etc.) with realistic byte counts. `ListObjectsV2` prefix-by-VIN matches. Public HEAD against `https://dealer-addendums.s3.us-west-1.amazonaws.com/{VIN}.pdf` returns 200.
- `print_history.pdf_url` for the new rows points at the flat key; older rows still carry the legacy nested URLs and won't move until reprint.

**S3 access model — confirmed correct 2026-05-31.** The `dealer-addendums` bucket is intentionally configured as a public-read store with permissive CORS, and **this is the right setup** for two production constraints:

1. **Dealer-website integration (1,600+ domains).** Each dealer site links to its inventory's addendums via direct `<a href="https://dealer-addendums.s3.us-west-1.amazonaws.com/{VIN}.pdf">…</a>` markup. These domains can't be enumerated, so:
   - Bucket policy has a public `PublicReadGetObject` statement (`Principal: "*"`, `Action: s3:GetObject`). Unauthenticated HEAD/GET of `{VIN}.pdf` returns 200 directly — no signed URL needed for dealer-side links.
   - PublicAccessBlock all four flags are `false` (i.e., NOT blocking).
   - CORS `AllowedOrigins: ["*"]` covers the subset of dealer sites that preview PDFs via JS `fetch()` (anchor links and `<iframe src>` don't trigger CORS at all).
2. **Legacy DA app writes through 2026-07** (~6-week parallel-run window). The legacy Laravel app writes via the server-side AWS SDK using IAM credentials — **CORS is browser-only and does not apply to server-to-S3 writes**. What matters there is the legacy IAM identity having `s3:PutObject` on `arn:aws:s3:::dealer-addendums/*`, which it already has. No bucket-side change is needed to support the legacy write path during the transition.

Earlier suggestion to tighten `AllowedOrigins` to `app.dealeraddendums.com` only was **wrong given the dealer-website constraint** and is hereby retracted. Keep the wildcard.

PrintPreviewModal's CORS-failure fallback path (commit `e5b88b4`) stays in code as defensive insurance — silent under the current config since rejections don't happen.

**Open decisions for Allan (no action until he says so):**
- **Backfill of old nested keys.** PDFs printed before today still live at `{internal_id}/{vehicle_uuid}/{VIN}.pdf` and only migrate to flat `{VIN}.pdf` on reprint. `scripts/backfill-flat-vin-pdfs.mjs` is a one-time idempotent copy ready to run when Allan says go.
- **Doc-type variant naming.** Infosheet and buyer's-guide keep VIN-prefixed suffixes so an infosheet print doesn't overwrite the addendum's `{VIN}.pdf`. The Spanish buyer's-guide variant currently has no suffix path (it's only emitted inside the `en+es` zip and not persisted standalone) — verify that's still the desired behavior or wire a `{VIN}_buyers_guide_es.pdf` upload from the service.
- **Merged bulk PDF persistence.** The bulk run still uploads its combined output to a timestamped `{internal_id}/{vehicleUuid}/{docType}_bulk_{n}_{ts}.pdf` key. If the bucket should hold only `{VIN}.pdf` files (per-vehicle, no run-level artifacts), drop the merged-upload tail in the service — small tweak since da-platform consumes the merged via the signed URL, not the bucket.
- **Post-transition (after legacy writes stop, ~2026-07):** revisit whether `AllowedMethods: ["POST"]` is still needed and consider rotating/scoping the legacy IAM identity once it's no longer writing. CORS itself stays `["*"]` indefinitely — dealer-website use case is permanent.

---

## Phase 10b — PDF Microservice (original design notes)

### Goal
Offload all Puppeteer/PDF rendering from the main DA Platform EC2 to a dedicated high-resource server. Eliminates PDF generation competing with app traffic as dealer volume grows.

### Infrastructure
- **Instance:** c6i.2xlarge (8 vCPU, 16 GB RAM), us-west-1, same VPC as DA Platform
- **Private IP:** `172.31.71.67`  <!-- was documented as 172.31.18.195; actual provisioned IP confirmed in lib/pdf-service-client.ts and on prod -->
- **Port:** `3001` — internal HTTP, reached as `http://172.31.71.67:3001`
- **AMI:** Ubuntu 22.04 LTS
- **Storage:** 40 GB gp3
- **Public IP:** None — internal only
- **SSH key:** `~/ssh/da-pdf-service.pem`
- **Security group inbound:** port 22 (SSH), port 3001 from `172.31.23.99/32` (DA Platform private IP) only
- **PM2 app name:** `da-pdf-service`, port 3001
- **Repo:** `github.com/dealeraddendums/da-pdf-service`
- Node.js/Express service, PM2-managed
- Auth: internal API key via `X-API-Key` header (same pattern as da-billing)
- S3 uploads happen on the PDF service — main app receives S3 key in response
- IAM: use existing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars (s3:PutObject + s3:GetObject on `dealer-addendums` bucket)
- **Setup:** Claude Code handles server bootstrap (Node, PM2, Puppeteer/Chrome deps)

### Architecture — Async

Single prints and bulk prints both go async:
1. Main app POSTs job to PDF service (`/api/pdf/generate` or `/api/pdf/bulk`)
2. PDF service queues the job, returns `{ jobId }` immediately
3. PDF service renders via Puppeteer, overlays via pdf-lib, uploads to S3
4. Main app polls `GET /api/pdf/status/:jobId` → `{ status, s3Key, signedUrl }`
5. UI shows progress spinner; redirect/download fires when status = `complete`

### What Moves to PDF Service
- All Puppeteer rendering (addendum, infosheet, bulk combined PDF)
- pdf-lib Buyer's Guide overlay
- S3 upload of final PDF
- Puppeteer dependency removed from `da-platform` entirely

### Changes to DA Platform
- `app/api/pdf/generate/route.ts` — replace Puppeteer call with POST to PDF service
- `app/api/pdf/bulk/route.ts` — replace Puppeteer call with POST to PDF service
- `lib/pdf-html.ts` — stays as HTML template generator; output sent to PDF service
- New env var: `PDF_SERVICE_URL` (internal EC2 URL), `PDF_SERVICE_API_KEY`
- Puppeteer removed from `package.json`

### PDF Naming (unchanged)
Same S3 key conventions as today — PDF service writes to the same `dealer-addendums` bucket.

---

## Phase 14 — HubSpot Sync (DA → HubSpot, one-way)

### Status — updated 2026-05-31

**Shipped + verified end-to-end on prod.** Portal `23896347`. One-way DA Platform → HubSpot — DA is single source of truth.

**14a — write path (fire-and-forget from lifecycle routes):**
- `lib/hubspot.ts` typed client, Bearer auth, three-stage idempotent upsert (PATCH by stored id → search by natural key → POST create). 404 on PATCH falls through to search/create so a manual HubSpot delete self-heals on the next sync.
- `lib/sync-hubspot.ts` property builders + fire-and-forget `fireDealerSync` / `fireGroupSync` / `fireProfileSync`.
- Hooked at: `app/api/dealers/route.ts` POST + PATCH, `app/api/groups/route.ts` POST, `app/api/invite/accept/route.ts`.
- Errors land in `hubspot_sync_errors` (migration 082) instead of bubbling to the user.

**Reliable trial-create path (commit d1b7048):** New individual-dealer create with `lifecyclestage=Dealer Trial` is the trigger event for the HubSpot onboarding workflow (Marketing OS Phase 5, not built yet). The create path uses `syncDealerCreateReliable` — 3× retry with 500ms/1.5s/4s backoff, on terminal failure logs to `hubspot_sync_errors` AND sends a Mandrill alert to support@. Inline-created users get a `fireProfileSync` right after the auth user lands so the associated Contact appears moments after the Trial-stage Company. PATCH path stays on the plain fire-and-forget — updates don't fire workflow enrollments.

**14b — daily cron** (`/api/cron/sync-hubspot-computed`, auth `x-cron-secret`, EasyCron `0 8 * * *` UTC, ✅ live): refreshes `prints_last_30`, `prints_last_12mo`, `dealers_in_group`, and re-evaluates Trial → Trial Expired (>30 days OR >30 prints since `dealer.created_at` — first_login_at doesn't exist on any DA table). PATCHes spaced ~35ms apart. Fire-and-forget pattern (commit bcc4686): the route counts what's queued, returns `{ok, queued: {dealers, groups}}` in <300ms, and runs the ~2.2k-record loop in `void (async () => {...})()` under PM2 — ALB's 60s cap was the original gotcha that 504'd EasyCron before the refactor. Progress logs every 500 dealers via `pm2 logs`.

**Backfill:** `scripts/backfill-hubspot.mjs` walks every active dealer/group/profile in 1000-row chunks (PostgREST default cap). 2,025 dealers + 214 groups + 3,646 profiles → ~100% coverage with `hubspot_*_id` written back to Supabase. Idempotent — safe to re-run.

### Field-mapping reference

**Company ⟵ dealer** (live in `lib/sync-hubspot.ts → dealerCompanyProperties`):

| HubSpot prop | DA source |
|---|---|
| `dealerid` | `dealer.inventory_dealer_id` (Aurora numeric) |
| `platformid` AND `da_dealer_` | `dealer.dealer_id` (text slug — both fields exist in portal, write same value) |
| `billingid` | `dealer.billing_customer_id ?? dealer.internal_id` |
| `groupid` | `groups.internal_id` for the dealer's group |
| `subscription_type` | `dealer.account_type` normalized: `Manual` / `Auto-Web` / `Auto-DMS` / `Free` / `Trial` / `PAYGo`. Strips `$NN` price suffixes; `sub-*` slugs collapse to `Manual` / `Auto-Web` / `Auto-DMS`. |
| `lifecyclestage` | paying account → `customer`; trial → `60435067` (Dealer Trial). Cron flips to `65495635` (Trial Expired) past 30d/30 prints. |
| `feed_company_type` | nulls out when there's no provider; otherwise `Auto-DMS`/`Auto-Web` based on `inventory_provider_is_dms`. |

**Lifecycle stage internal values** (custom stages have numeric IDs, not human-readable strings):

| Stage | Value |
|---|---|
| Customer | `customer` |
| Dealer Trial | `60435067` |
| Group/Reseller Trial | `60429213` |
| Trial Expired | `65495635` |
| Account Paused | `78548766` |
| Account Downgraded | `108387744` |

### Env vars (already in prod `.env.production`)

```
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-…   # private-app token, Bearer auth
HUBSPOT_PORTAL_ID=23896347
```

Token is also writable from the marketing-side `HUBSPOT_API_KEY` — keep distinct.

## Phase 12 — Enterprise White Label (Queued)

### Goal
Large dealer groups (e.g., AutoNation) who want the platform to feel like their own product. We are NOT selling or licensing the software — this is cosmetic branding only, scoped to specific approved groups.

### Features
- **Custom subdomain** per group — e.g., `addendums.autonation.com` routed to the DA Platform via DNS + Nginx + SSL cert
- **Custom logo** — group logo replaces DA logo in topbar and emails
- **Skinning** — any simple CSS-level changes: topbar color, accent color, favicon. No structural changes.
- **Custom email sender** — transactional emails (welcome, invite, notifications) sent from a group-specific address (e.g., `noreply@autonation.com`) via Mandrill sending domain configuration
- **Custom welcome email** — group-specific copy and branding

### Technical Approach
- Next.js middleware reads the incoming hostname and resolves it to a group record in Supabase
- `groups` table gains: `custom_domain`, `brand_logo_url`, `brand_primary_color`, `brand_email_from`, `brand_email_name`
- Branding config injected into layout via server component — no client-side flicker
- SSL: AWS Certificate Manager + ALB listener rule per subdomain
- Mandrill: per-group sending domain must be verified in Mandrill before use
- Fallback: if no group brand config found, render standard DA Platform branding

### Scope Limits
- No white-labeled mobile apps in this phase (mobile is Phase 15)
- No custom domain for dealer subaccounts within a white-labeled group — subdomain is group-wide only
- Only groups explicitly approved by Allan get a custom domain

---

## Phase 13 — Dealer Self-Serve Onboarding (Queued)

### Goal
A magic link Allan (or legacy platform) can send to any dealer to self-onboard onto DA 5.0. Dealer clicks, sets a password, and is live — legacy billing is simultaneously unwound.

### Magic Link Format
`https://app.dealeraddendums.com/onboard?email={email}&dealer_id={dealer_id}&token={signed_token}`

- `token` is a signed, time-limited JWT (or Supabase invite token) generated server-side
- Can be sent manually by Allan or embedded as a button/link on the legacy platform
- CTA copy: **"Upgrade to DA 5.0 Now!"**

### Onboarding Flow
1. Dealer clicks link → `/onboard` page validates token + email + dealer_id
2. Dealer creates a new password (min 8 chars) — same UI pattern as existing invite flow
3. On password confirmation:
   - Supabase auth user created/activated for this dealer
   - Legacy DA subscription changed to **Free/Trial** — this automatically pauses the recurring bill in legacy DA (no FreshBooks API call needed)
   - Existing FreshBooks invoices are left as-is — they remain outstanding but no new ones are generated
   - New invoices going forward are created by `billing.dealeraddendums.com` only
   - ⚠️ The dealer's recurring template in `billing.dealeraddendums.com` is **preserved** — do NOT delete it
   - `migration_status` updated on dealer record in Supabase
4. Dealer lands on DA Platform dashboard — onboarding complete

### Billing Transition Notes
- Changing legacy DA subscription to Free/Trial pauses recurring automatically — no direct FreshBooks manipulation required
- All future invoicing runs through da-billing exclusively from this point forward
- Outstanding FreshBooks invoices remain — not Allan's problem to resolve at migration time

### Link Embedding (Legacy Platform)
- A button or banner on the legacy platform dealer dashboard can embed the magic link
- Link generation endpoint: `POST /api/onboard/generate-link` (super_admin or system only)
- Allan can also generate links from the super admin panel

---

## Phase 15 — iOS & Android Apps (Queued)

### Goal
Native mobile apps for dealers on the lot — scan a VIN, assign products, print or queue for later. Not a mobile mirror of the full web app. Focused entirely on the lot workflow.

### Reference App
Existing app (screenshots captured) — use as UX reference, not codebase. The new app connects to the DA Platform (Supabase) not the legacy backend.

> **⚠️ 2026-07-07 — this Phase 15 section is superseded by `da-mobile/IOS-APP-SPEC.md` (v1.2).** Key changes vs the notes below: stack is **Swift/SwiftUI native iOS** (not React Native; Android deferred); **admin logins ARE included** (group_admin/group_user via `active_dealer_id`, super_admin via ghost token in `X-DA-Ghost-Token` header); queue = existing **`dealer_vehicles.print_queue` column** (NOT a separate `print_queue` table); the app bulk-prints its own queue; icon colors: gray=unprinted, green=printed, orange=queued. **Web-side prep shipped 2026-07-07** (commits `68ea239`–`4e3d7a4`, migration 123): `recordPrint()` dequeue on addendum prints, `POST`/`DELETE /api/print-queue/[vehicleId]`, `queued=1` list filter, Dashboard Queued filter/orange Print Now/stat card, **platform-wide Bearer-JWT auth in `getJwtClaims()`** (previously cookie-only), and `POST /api/auth/ghost` JSON mint (super_admin, 2 h TTL, audited). Verified mobile API shapes are in the spec §6 + §9 — note `/api/pdf/generate?async=1` for JSON mode, and `/api/pdf/bulk` returns one merged PDF + `X-Print-Token` header (blocking, max 50). **M1 (scaffold + auth + role routing) shipped 2026-07-07** — da-mobile PR #1 (`901a7ef`), plus new da-platform endpoint **`GET /api/auth/me`** (`334719a`, live) as the app's single identity/context source. ⚠️ The Supabase JWT carries **no custom role claims** (no `custom_access_token_hook` installed) — role/dealer/group/ghost context must come from `/api/auth/me`, not the token. `PATCH /api/profiles/active-dealer` body key is `dealerId` (camelCase).

---

### Screens & Flows

#### 1. Login / Splash
- DA logo, "WELCOME!", tagline
- Username + password login → authenticates against DA Platform (Supabase auth)
- Auth token stored securely on device
- Future: passkey when mobile platform support matures

#### 2. Home / Dashboard
- After login: "WELCOME!" + user name + dealership name
- Three buttons: **Scan Vehicles** · **Vehicle Overview** · **Settings**

#### 3. Scanner
- Bottom tab: QR/barcode icon (left tab)
- Three scan modes toggled by buttons: **VIN** · **Barcode** · **QR Code**
- Live camera viewfinder with orange border
- Flashlight toggle button
- Mode-specific instructions ("Position VIN clearly in frame" / "Avoid Shadows and Glare")
- "Capture VIN Now" button — captures frame and decodes
- Manual entry field: "Scan or enter VIN manually"
- "Go To Vehicle" button (enabled once VIN resolved)

**VIN Scan Logic:**
1. Scan/capture VIN
2. Look up vehicle in dealer's Supabase inventory
3. If found → go to Create Addendum screen for that vehicle
4. If not found → run VIN decode (NHTSA or VinQuery) → add vehicle to dealer's Supabase inventory → go to Create Addendum screen

#### 4. Vehicle Overview
- Bottom tab: car icon (middle tab)
- Filterable list: **Condition** dropdown · **Status** dropdown
- Search icon (top right)
- Each row: Year/Make/Model · VIN · Stock# · printer status icon + chevron
  - **Green printer** = not yet printed
  - **Orange printer** = in print queue
- Tap row → go to Create Addendum for that vehicle

#### 5. Create Addendum
- Header: "Create Addendum"
- Vehicle details displayed: VIN, Year, Make, Model, Body Style
- Stock number field (editable)
- Price/MSRP field (editable)
- **Select Option** dropdown + **Add** button — pulls dealer's products from Supabase `vehicle_options`
- **Options added to vehicle** list — each with Delete button
- Three action buttons:
  - **Print Now** (green) — triggers DA Platform PDF generation API; PDF delivered to device or AirPrint/Google Cloud Print
  - **Print Later** (orange/yellow) — adds vehicle + selected products to `print_queue` in Supabase; shows "Vehicle added to print queue." success dialog; printer icon turns orange in Vehicle Overview
  - **Cancel** (red) — discard and return

**Select Option modal:** scrollable list of dealer's products; tap to select; Cancel button

#### 6. Print Queue (web dashboard)
- Print queue entries stored in Supabase `print_queue` table (dealer-scoped)
- Accessible from DA Platform web dashboard — dealer can bulk-print queued vehicles from desktop
- Mobile app shows queue status via printer icon color; does not manage the queue beyond adding to it

#### 7. Settings
- Bottom tab: gear icon (right tab)
- Scope TBD — at minimum: logout, dealer/user info display

---

### Explicitly Excluded
- User management
- Billing / label orders
- Products (options) management
- Template Builder
- Any super admin or group admin functionality

---

### Technical Approach
- **Native apps** — not PWA or webview. Required for camera/scanner performance.
- **Repo:** `github.com/dealeraddendums/da-mobile`
- **Stack: React Native** — single codebase for iOS + Android. Camera/scanning via Vision Camera library.
- **Auth:** Supabase email+password; passkey when mobile support matures
- **API:** Consumes existing DA Platform REST API endpoints. No new backend — mobile is a client.
- **Print Now:** Calls DA Platform PDF generation API (Phase 10b PDF service) → returns signed S3 URL → open in device PDF viewer or native print dialog
- **Print Queue:** `print_queue` Supabase table — `id`, `dealer_id`, `vehicle_id`, `vin`, `products` (jsonb), `created_by`, `created_at`, `printed_at`
- **VIN decode fallback:** NHTSA free API or VinQuery (already in platform) — same as web

---

## Outstanding Items

### Manual tasks (Allan)
- ✅ EasyCron `0 2 1 * *` → sync-vehicle-reference
- ✅ EasyCron `0 9 5 * *` → chromedata-usage-report
- ✅ EasyCron `0 3 * * *` → harvest-vin-trims
- ✅ Run manual vehicle backfill in tmux (script ready)
- ✅ EasyCron `0 10 * * *` → sync-xps-tracking (after Phase 10 deploy confirmed)
- ✅ EasyCron `0 8 * * *` UTC → sync-hubspot-computed (Phase 14b, fire-and-forget after 504 fix)
- ✅ Verify ChromeData report format via Reports page manual trigger

### Code items
- ⬜ NHTSA trim pagination fix — harvester only processes 1000 VINs (Supabase page limit)
- ✅ Phase 10b — PDF Microservice: fully cut over. D.5 (bulk → service, per-vehicle `items[].s3Key`) and E.2 (puppeteer removed from da-platform) both shipped — commits efe91fb, 9bfbf35. Only the bulk `buyer_guide` pdf-lib overlay still renders locally.
- ⬜ Phase 12 — Enterprise White Label (custom subdomains + branding for large groups)
- ⬜ Phase 13 — Dealer Self-Serve Onboarding (magic link → password → FreshBooks unwind)
- ✅ Phase 14 — HubSpot Sync (DA → HubSpot, one-way): 14a write path + 14b cron shipped; backfill complete (2,025 dealers / 214 groups / 3,646 profiles). EasyCron registration for `/api/cron/sync-hubspot-computed` (schedule `0 8 * * *` UTC) still pending Allan.
- 🔵 Phase 15 — iOS & Android Native Apps: spec complete (`da-mobile/IOS-APP-SPEC.md` v1.2, Swift/SwiftUI); web-side prep shipped 2026-07-07 (queue API + Queued filter + Bearer auth + ghost mint); iOS client build is next
- ⬜ `billing_sync_errors` alerting — panel flagging non-zero error counts so Box/billing failures don't sit silent (Box SDK failed silently 2 days before discovery)
- ⬜ Box folder backfill for ~1,600 legacy dealers — all have `box_folder_id = null`; needs audited bulk backfill script when ready

## Key S3 Buckets

| Bucket | Region | Purpose |
|---|---|---|
| `dealer-addendums` | us-west-1 | PDFs + ChromeData reports |
| `addendum-product-images` | us-east-1 | Product images |
| `new-dealer-logos` | us-east-1 | Dealer logos (CloudFront: d1xlji8qxtrdmo.cloudfront.net) |
| `new-infobox-images` | us-east-1 | Infobox PNGs |
| `new-infosheet-backgrounds` | us-east-1 | Infosheet frames |
| `new-addendum-backgrounds` | us-east-1 | Addendum frames |
| `da-platform-backups` | us-west-1 | Daily Supabase backups |

## Cron Jobs (EasyCron)

| Schedule | URL / Server | Status |
|---|---|---|
| `0 2 * * *` | `/api/cron/backup-supabase` | ✅ |
| `0 3 * * 0` | `/api/cron/archive-vehicles` | ✅ |
| `0 3 1 * *` | `/api/cron/purge-old-pdfs` | ✅ |
| `0 2 1 * *` | `/api/cron/sync-vehicle-reference` | ✅ |
| `0 3 * * *` | `/api/cron/harvest-vin-trims` | ✅ |
| `0 9 5 * *` | `/api/cron/chromedata-usage-report` | ✅ |
| `0 10 * * *` | `/api/cron/sync-xps-tracking` | ✅ |
| `0 10 * * *` | `/api/migration/send-follow-ups` | ✅ — migration invite drip (Days 3/10/30/60/90 after invited_at) |

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION=us-east-1
ANTHROPIC_API_KEY
VINQUERY_API_KEY
MANDRILL_API_KEY
CRON_SECRET
NEXT_PUBLIC_MAPBOX_TOKEN
MIGRATION_INVITE_TOKEN
CHROMEDATA_ACCOUNT_ID=323951
CHROMEDATA_MEDIA_SECRET=
CDK_API_URL=https://3pa.dmotorworks.com/pip-extract/inventoryvehicleext/extract
CDK_API_USERNAME=dlraddendums
CDK_API_PASSWORD=c7YvfYLxfwSq
CERBERUS_PROXY_SECRET=            # in nginx fastcgi_param, not .env
CERBERUS_FTP_USER=                # in nginx fastcgi_param, not .env
CERBERUS_FTP_PASS=                # in nginx fastcgi_param, not .env
BILLING_API_KEY=dab_b1ce5e7768aef3f94e652a69303f3ecce44f487244824e96562c9d0704b58a7f
BILLING_PUBLIC_URL=https://billing.dealeraddendums.com   # customer-facing pay URL base; default if unset
PDF_SERVICE_URL=http://172.31.71.67:3001                 # Phase 10b PDF microservice (internal only)
PDF_SERVICE_API_KEY=                                     # X-API-Key for da-pdf-service
USE_PDF_SERVICE=1                                         # 1/true → render via PDF service; 0 (or missing URL/key) → routes return 503 (no local Puppeteer fallback — removed in E.2)
XPS_API_KEY=Jx5vg3PLLL0HGCQV4YAyIuHdAMf0sXKb
XPS_CUSTOMER_ID=12302875
XPS_INTEGRATION_ID=91819
RP_ID=app.dealeraddendums.com
RP_NAME=DealerAddendums
RP_ORIGIN=https://app.dealeraddendums.com
```

## Document Types & Canvas Dimensions

| Type | Paper | Native | Display canvas |
|---|---|---|---|
| 4¼″ Addendum | 4.25"×11" | 638×1650px | 408×1056px |
| 3⅛″ Addendum | 3.125"×11" | 469×1650px | 300×1056px |
| 8½″ Addendum | 8.5"×11" | 816×1056px | 816×1056px |
| 8½″ Infosheet | 8.5"×11" | 2657×3438px | 816×1056px |
| Landscape Infosheet | 11"×8.5" | varies | dynamic (per custom size dims) |

Custom paper sizes (`dealer_custom_sizes`) carry a `doc_type` of `addendum` or `infosheet` (migration 084). The builder resolves "is this an infosheet" via `resolveIsInfosheet(paperSize, customSizes)`: true for the built-in `'infosheet'` *or* any custom size whose `doc_type` is `'infosheet'`. PDF `generate` and `bulk` routes consult the same `doc_type` when the paperSize is a custom UUID. Custom infosheet sizes start with a blank canvas (no LAYOUT_INFOSHEET portrait auto-load) — operator places widgets onto the uploaded background.

## Infrastructure IPs (all servers)

| Server | IP | Notes |
|---|---|---|
| DA Platform EC2 | `18.145.132.52` | us-west-1, private `172.31.23.99` |
| PDF Service (da-pdf-service) | internal only | us-west-1, private `172.31.71.67`, port 3001 |
| Legacy Platform (Hub) | `52.22.32.67` | being decommissioned |
| Legacy ETL (DND ETL 2025) | `44.206.22.243` | |
| ETL2 | `34.227.197.196` | |
| VPN DND | `34.202.235.98` | |
| HubSpot/Intercom Sync | `35.174.76.63` | |
| FTP Server (Windows) | `34.193.4.78` | Cerberus FTP Pro 12.8.0.0 |
