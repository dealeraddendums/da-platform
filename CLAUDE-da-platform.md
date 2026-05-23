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

**Legacy Platform EC2:** `ssh -i "~/ssh/DA2025.pem" ubuntu@ec2-52-22-32-67.compute-1.amazonaws.com`
**FTP Server EC2:** `ec2-34-193-4-78.compute-1.amazonaws.com` — Windows, Cerberus FTP Pro 12.8.0.0

## Stack

- Next.js 14.2.35 (App Router)
- Supabase (auth + all app data)
- Aurora MySQL (READ ONLY — dead code removed, never query)
- Puppeteer (PDF generation)
- pdf-lib (Buyer's Guide overlay)
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
- Single: `{internal_id}/{vehicle_uuid}/{VIN}.pdf`
- Infosheet: `{internal_id}/{vehicle_uuid}/{VIN}_infosheet.pdf`
- Buyer's Guide: `{internal_id}/{vehicle_uuid}/{VIN}_buyers_guide.pdf`
- Bulk combined: `[DealerName]_Addendums_[date].pdf`
- Bulk also saves individual `{VIN}.pdf` per vehicle to S3

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

### Disclaimer Widget
- Draggable onto canvas under STRUCTURAL section
- Renders all active disclaimers (group first, dealer second)
- No automatic PDF injection — only prints if widget placed
- Group admins place in group templates

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
- When true: Builder nav hidden for dealer, Print Settings template dropdowns read-only
- group_admin ghost mode: Builder always accessible

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

### Label orders
- Creates XPS shipping order + da-billing template line item
- Stored in `label_orders` Supabase table
- Daily tracking sync: `POST /api/cron/sync-xps-tracking` → `0 10 * * *`

## Migration Status

Current highest migration: **070** (`ftp_users` notes table)

## Phase Status

| Phase | Name | Status |
|---|---|---|
| 1–9b | All prior phases | ✅ Complete |
| 10 | Billing Integration | ✅ Complete |
| 11 | Admin Ops | ⬜ Deferred |
| 12 | Enterprise White Label | ⬜ Not started |
| 13 | Dealer Migration & Onboarding | ⬜ Not started |
| 14 | HubSpot + Billing Sync | 🔜 Next |

## Phase 14 — HubSpot + Billing Sync (Next)

### Architecture
Event-driven, non-blocking sync service. DA Platform create/edit/delete events sync to:
- HubSpot portal `23896347`
- da-billing

### HubSpot details
- Aurora has `HUBSPOT_COMPANY_ID` on `dealer_dim`/`dealer_group`
- Aurora has `HUBSPOT_CONTACT_ID` on users
- URL formats: dealers/groups = `/record/0-2/{ID}`, contacts = `/record/0-1/{ID}`
- Needs: HubSpot private app token

### Events to sync
- Dealer created/updated/deleted
- Dealer added/removed from group
- Subscription upgraded/downgraded
- Group created/updated/deleted

## Outstanding Items

### Manual tasks (Allan)
- ✅ EasyCron `0 2 1 * *` → sync-vehicle-reference
- ✅ EasyCron `0 9 5 * *` → chromedata-usage-report
- ✅ EasyCron `0 3 * * *` → harvest-vin-trims
- ⬜ Run manual vehicle backfill in tmux (script ready)
- ⬜ EasyCron `0 10 * * *` → sync-xps-tracking (after Phase 10 deploy confirmed)
- ⬜ Verify ChromeData report format via Reports page manual trigger

### Code items
- ⬜ NHTSA trim pagination fix — harvester only processes 1000 VINs (Supabase page limit)
- ⬜ Phase 14 — HubSpot + Billing Sync

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
| `0 10 * * *` | `/api/cron/sync-xps-tracking` | ⬜ add |

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

## Infrastructure IPs (all servers)

| Server | IP | Notes |
|---|---|---|
| DA Platform EC2 | `18.145.132.52` | us-west-1, private `172.31.23.99` |
| Legacy Platform (Hub) | `52.22.32.67` | being decommissioned |
| Legacy ETL (DND ETL 2025) | `44.206.22.243` | |
| ETL2 | `34.227.197.196` | |
| VPN DND | `34.202.235.98` | |
| HubSpot/Intercom Sync | `35.174.76.63` | |
| FTP Server (Windows) | `34.193.4.78` | Cerberus FTP Pro 12.8.0.0 |
