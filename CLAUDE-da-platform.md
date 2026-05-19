# CLAUDE.md — DA Platform
> See `../CLAUDE.md` for shared infrastructure, design system, team, and architectural rules.
> This file covers da-platform specific context only.

---

## 🔴 ALL ACTIONS PRE-APPROVED — EXECUTE AUTONOMOUSLY

---

## Identity

**Repo:** `github.com/dealeraddendums/da-platform`
**URL:** https://app.dealeraddendums.com
**EC2:** `ec2-18-145-132-52.us-west-1.compute.amazonaws.com`
**SSH:** `ssh -i ~/ssh/DA_Platform_2026.pem ubuntu@ec2-18-145-132-52.us-west-1.compute.amazonaws.com`
**App path:** `/var/www/da-platform`
**PM2 service:** `da-platform` (port 3000)
**Supabase:** `https://byouefbebqgffhtfdggu.supabase.co`
**Deploy:** `git pull && npm ci && npm run build && pm2 restart da-platform --update-env`
**Logs:** `/var/log/da-platform/`

## Stack

- Next.js 14 (App Router)
- Supabase (auth + all app data)
- Aurora MySQL (READ ONLY — dead code only, never queried in production)
- Puppeteer (PDF generation)
- pdf-lib (Buyer's Guide overlay)
- S3 `dealer-addendums` bucket (PDF storage, 24hr signed URLs)
- Mapbox GL JS (dealer map on super_admin dashboard)
- Mandrill (transactional email)
- @simplewebauthn/server + browser v13 (passkey auth)

## Infrastructure Notes

- Behind ALB — EC2 nginx only sees HTTP on port 80; ALB handles SSL
- HSTS set by `middleware.ts` (not nginx)
- `server_tokens off` applied to nginx
- GitHub Action: push to `main` → auto-deploys to EC2
- Always use `pm2 restart da-platform --update-env` to pick up .env changes

## Design System

**Non-negotiable. Every UI element must conform.**

```css
--navy:        #2a2b3c;   /* topbar, sidebar */
--orange:      #ffa500;   /* active nav accent */
--blue:        #1976d2;   /* primary buttons */
--blue-light:  #2196f3;   /* secondary blue, hover */
--success:     #4caf50;   /* success states */
--error:       #ff5252;   /* errors, destructive */
--bg-app:      #3a6897;   /* page background */
--bg-surface:  #ffffff;   /* cards, panels */
--bg-subtle:   #f5f6f7;   /* table rows, input bg */
--text-primary:   #333333;
--text-secondary: #55595c;
--text-muted:     #78828c;
--border:       #e0e0e0;
--border-strong:#c0c0c0;
```

- Font: Roboto only (no DM Sans, no other fonts)
- Cards: white bg, `1px #e0e0e0` border, `6px` radius, **NO box-shadow**
- Buttons: Primary `#1976d2`, Success `#4caf50`, Danger `#ff5252`, Orange `#ffa500`
- No gradients. No border-radius > 6px (pills at 20px are OK). No animations > 150ms.

## Sidebar Navigation

**Dealer roles (dealer_admin, dealer_user, dealer_restricted):**
Dashboard → Products → Builder → Users → My Profile → Print Settings → [divider] → Order Supplies

**Super admin:**
Dashboard → Dealers → Groups → Users → My Profile → [FEEDS] FTP Server / ETL Server → [ADMIN] Reports / Billing / API Docs / Decoder / Documents / Buyer's Guide PDFs / Image Library

**Group admin:**
Dashboard → My Group → Builder → [divider] → Order Supplies

## Role System

| Role | Access |
|---|---|
| `super_admin` | Full platform, impersonation, ghost mode, all dealers/groups |
| `group_admin` | Scoped to own group and member dealers |
| `dealer_admin` | Full access to own dealer account |
| `dealer_user` | Read/print within own dealer |
| `dealer_restricted` | Same as dealer_user, displayed as "Dealer User" |

## Ghost Mode

Super admin can enter any dealer's or group's context without a real user account.

**Dealer ghost mode:**
- `POST /api/admin/ghost` with `{ dealer_id }` → sets `da_ghost_token` cookie
- Orange banner: "👻 Ghost Mode — [Dealer Name] — Operating without a user account"
- All API routes use ghost dealer_id for scoping
- Exit → `POST /api/admin/ghost/exit` → redirects to /dealers
- Expires after 2 hours of inactivity
- All actions logged to `admin_audit` with `ghost_mode=true`

**Group ghost mode:**
- `POST /api/admin/ghost` with `{ group_id }` → sets group ghost cookie
- Orange banner: "👻 Ghost Mode — [Group Name] — Operating as Group Admin"
- Dealer and group ghost modes are mutually exclusive
- Exit → redirects to /groups

**Dealers list:** 👻 icon on rows with no user account. Click name → ghost mode if no users, impersonation if users exist.
**Groups list:** Same pattern — 👻 icon, click name → ghost or impersonation.

## Auth — Critical: Email Fallback in getJwtClaims()

`lib/auth.ts` → `getJwtClaims()` looks up profile by `session.user.id` first.
If no profile found (ETL-synced profiles may have UUID mismatch), falls back to lookup by email.
PM2 logs show `[auth] profile resolved by email fallback — UUID mismatch` when this fires.
**Do not remove the email fallback** — it is required for impersonated sessions to work.

## Critical Rules (in addition to master CLAUDE.md)

### Aurora is Dead — Zero Queries
- All production routes use Supabase only
- `lib/aurora.ts` exists as dead code — never import it
- If you find yourself writing `getPool()` or `pool.execute`: STOP

### The Builder NEVER Prints
- `/builder` is for designing and saving templates only
- Print flow: Inventory → Print button → intermediate print screen → PDF generated server-side
- No print/PDF button ever in the Builder UI

### Single Renderer Rule
- `components/builder/widgetRenderer.ts` → `renderW()` is the ONLY renderer for widget HTML
- Both canvas and PDF pipe through `renderW()` — never build widget HTML independently
- Any divergence between canvas and PDF output is a bug

### WYSIWYG Rule
- `applyVehicleDataToWidgets()` must be called on: init, switchPaperSize, template load
- All dealer data comes from Supabase `dealers` table — never Aurora fallback
- Ghost mode: use ghost dealer_id cookie for dealer context

### PDF Naming
Download filenames: `[VIN].pdf` (single print) or `[DealerName]_Addendums_[date].pdf` (bulk).

Canonical S3 keys (overwrite-on-print so dealer-website integrations can link by stable URL):
- Addendum: `{internal_id}/{vehicle_uuid}/{VIN}.pdf`
- Infosheet: `{internal_id}/{vehicle_uuid}/{VIN}_infosheet.pdf`
- Buyer's Guide: `{internal_id}/{vehicle_uuid}/{VIN}_buyers_guide.pdf`

Built via `buildPdfKey()` in `lib/s3-upload.ts` — every single-print and bulk-print upload must use it. Bulk print also writes per-vehicle PDFs to canonical keys in the background (additive — combined merged-bulk upload is unchanged). Falls back to vehicle UUID for the filename when VIN is missing. Purge cron filters strictly on `LastModified`, so an actively-printed VIN keeps its slot fresh.

## Migration Status

Current highest migration: **050**
Always check before creating a new migration to avoid conflicts.
Migration files: `supabase/migrations/`

Key migrations:
- 042-043: Passkey auth, security hardening
- 044-047: ETL sync log, migration_status, per-job breakdown
- 048: invited_at column on dealers
- 049: required/suggested options (vehicle_options, addendum_library, addendum_data)
- 050: image_library table (display names for S3 images)

## Phase Status

| Phase | Name | Status |
|---|---|---|
| 1 | Auth & Users | ✅ Complete |
| 2 | Dealer Profile | ✅ Complete |
| 3 | Group Management | ✅ Complete |
| 4 | Vehicle Inventory | ✅ Complete |
| 5 | Addendum Settings | ✅ Complete |
| 5b | Addendum Options Engine | ✅ Complete |
| 6 | Unified Document Builder | ✅ Complete |
| 7 | VIN & AI Enrichment | ✅ Complete |
| 9 | Print/PDF Engine | ✅ Complete |
| 9b | Vehicle Archive | ✅ Complete |
| 10 | Billing | 🔜 Queued |
| 11 | Admin Ops | ⬜ Deferred |
| 12 | Enterprise White Label | ⬜ Not started |
| 13 | Dealer Migration & Onboarding | ⬜ Not started |
| 14 | HubSpot + Billing Sync | 🔜 Queued |

## Features Built (May 2026)

### Super Admin Dashboard
- Mapbox GL JS map showing all dealer locations (green=paid, blue=trial, red=recently printed)
- Live Activity ticker with Supabase Realtime subscription on addendum_data
- Filter tabs: ALL / PAID / TRIAL — filters both map markers and ticker
- Stat cards: Paid Dealers | Trial Dealers | Vehicles in System (% printed) | Addendums This Month
- Paid = subscription IN ('Automatic Web', 'Automatic DMS', 'Manual')
- Trial = subscription IN ('Free', 'Trial') or null

### Ghost Mode & Impersonation
- See Ghost Mode section above
- Dealers with no users show 👻 icon and enter ghost mode on click
- Groups with no group_admin show 👻 icon and enter ghost mode on click
- Impersonation uses magic link via `POST /api/admin/impersonate`
- Group impersonation via `POST /api/admin/impersonate-group`

### Migration Invite System
- `POST /api/migration/invite-dealer` — creates Supabase auth accounts + sends magic link emails
- `GET /api/migration/upgrade?dealer_id=X&token=Y` — legacy platform upgrade link
- MIGRATION_INVITE_TOKEN in .env.production
- Legacy link format: `https://app.dealeraddendums.com/api/migration/upgrade?dealer_id=[INVENTORY_DEALER_ID]&token=[TOKEN]`
- Welcome page at `/migration/welcome`
- "Invite All Users" button on Users page (super_admin only, ghost mode)
- Branded welcome email via Mandrill explaining DA Platform 5.0 features

### Builder
- Paper sizes (in order): 4¼″ Addendum | 3⅛″ Addendum | 8½″ Addendum | 8½″ Infosheet
- Custom size: super_admin only (hidden for all other roles)
- Toolbar: single row — zoom, paper size, font size inline with All Templates + Save Template
- Removed: New Template label, New/Used/CPO tabs, Preview button, rotate/flip, arrow alignment
- Multiple QR code widgets supported (no single-instance restriction)
- QR code supports z-index layering over other widgets including Infobox
- Right-click widget → Bring to Front / Send to Back / Bring Forward / Send Backward
- Background images load from Image Library (GET /api/admin/image-library/addendum)
- Hardcoded color backgrounds (01 Black, 02 Blue, etc.) removed
- Platform Backgrounds button opens ImagePickerModal

### Required vs Suggested Products (FTC Compliance)
- UI label is "Products" (renamed from "Options" for clarity — a Required item isn't optional). Code identifiers, routes (`/options`, `/api/options`), DB columns (`vehicle_options`, `addendum_options`, `option_name`, `option_price`), and prop names are unchanged. When editing UI strings, follow the existing pattern: rename display text, leave identifiers alone.
- Each product has `required` boolean (default: true)
- Required products: added to Asking Price (existing behavior)
- Suggested products: displayed separately, NOT added to Asking Price
- Widgets: "Required Products" and "Suggested Products" (Builder labels) — `options` and `suggested_options` widget types
- Suggested Price = Asking Price + sum of suggested product prices
- Default label: "Asking Price With All Options" (editable)
- Both widgets require a Combo addendum background
- Toggle visible on Products library AND vehicle addendum page
- All roles can toggle Required/Suggested on vehicle-specific products
- Backward compatible: null treated as required=true
- **Library → vehicle:** `addFromLibrary()` in `AddendumEditor.tsx` must propagate `required` from the `LibraryOption`; otherwise saved options default to required=true and silently flip Suggested products to Required

### Image Library
- Route: /admin/image-library (super_admin only)
- Three tabs: Infobox Images | Addendum Backgrounds | Infosheet Backgrounds
- Specs per tab:
  - Infobox: 553×339px, 150 DPI, PNG, max 5MB
  - Addendum: 638×1650px standard / 469×1650px narrow, 150 DPI, PNG, max 5MB
  - Infosheet: 2657×3438px, 150 DPI, PNG, max 10MB
- Editable display names (inline edit, auto-save on blur)
- image_library table in Supabase stores metadata + display names
- All authenticated users can read (for Builder); only super_admin can upload/delete
- API: GET/POST/DELETE /api/admin/image-library/[bucket]

### Dealer Profile
- Editable Inventory Dealer ID (super_admin only, pencil icon)
- Two-step confirmation: shows vehicle count that will be deactivated
- On confirm: updates inventory_dealer_id + sets all dealer_vehicles to inactive
- Logs to admin_audit: action='inventory_dealer_id_changed'

### Notifications
- New dealer created → email to support@dealeraddendums.com
- New group created → email to support@dealeraddendums.com
- "Save and Notify" group button → welcome email to group contact
- All via Mandrill using MANDRILL_API_KEY

### Vehicle History
- Table: `vehicle_audit_log` (NOT `vehicle_history`)
- Edit vehicle → audit entry with diff of changed fields. Format: "Vehicle updated · Color: White → Blue, MSRP: $30,000 → $32,000"
- Manual add (`POST /api/dealer-vehicles`) and CSV import (`POST /api/dealer-vehicles/import`) write `action: "import"` rows
- Print → audit `action: "print"` + `print_history` row (history API de-dupes by ±30s)
- API: `GET /api/dealer-vehicles/[id]/history` joins `vehicle_audit_log` + `print_history` and is dealer-scoped
- **Synthesized "Added to system" fallback:** when no `import` event exists for a vehicle (True-ETL inserts, pre-audit-log rows), the API joins `dealer_vehicles` for `date_added` + `created_by` and emits a virtual entry with `action: "added"`, `source: "synthesized"`. Read-only — never written to the DB. Surfaces `created_by` verbatim (e.g. `automatic80` for True ETL feed jobs). Panel labels it "Added to system".
- UI: per-row **History** button on the dashboard table (`ManualVehicleInventory.tsx`) opens `VehicleHistoryPanel` (right-side drawer); also surfaced on the per-vehicle addendum page.

### Vehicle Ingestion (Architectural)
- **True ETL** — nightly job that reads inventory supplier feed files and inserts into `dealer_vehicles`. This is the canonical vehicle ingestion path. Whatever it writes to `created_by` (e.g. `automatic80`) shows on the synthesized "Added to system" history entry.
- **DA Legacy ETL** (`da-legacy-etl` repo) — keeps non-vehicle data in sync from Aurora → Supabase until a dealer migrates: settings, users, prints, options, dealers, groups, logos. **Not responsible for new vehicle inserts going forward.** The vehicle-related entries in DA Legacy ETL's job table are about historical print/usage data, not feed ingestion.
- The master CLAUDE.md still describes DA Pulse as "ongoing vehicle inventory sync" — that's legacy framing; defer to True ETL for current/new vehicle ingestion.

### Other
- Settings renamed to "Print Settings" (route /settings unchanged)
- Version number (v5.0.0) in sidebar bottom left
- Users page: role filter tabs with clear active/inactive styling
- VIN decoder modal: shows only VIN + Stock + MSRP before decode, expands after
- Geocoding: new dealers geocoded via Mapbox, lat/lng stored on dealers table

## Key S3 Buckets

| Bucket | Region | Purpose |
|---|---|---|
| `dealer-addendums` | us-west-1 | Generated PDFs (signed 24hr URLs) |
| `addendum-product-images` | us-east-1 | Option/product images |
| `new-dealer-logos` | us-east-1 | Dealer logos (CloudFront: d1xlji8qxtrdmo.cloudfront.net) |
| `new-infobox-images` | us-east-1 | Infobox PNGs (553×339px, 150 DPI) |
| `new-infosheet-backgrounds` | us-east-1 | Infosheet frame PNGs (2657×3438px, 150 DPI) |
| `new-addendum-backgrounds` | us-east-1 | Addendum frame PNGs (638×1650px, 150 DPI) |
| `da-platform-backups` | us-west-1 | Daily Supabase backups (90-day lifecycle) |

## Cron Jobs (EasyCron)

| Job | Schedule | URL |
|---|---|---|
| Supabase backup | `0 2 * * *` | `/api/cron/backup-supabase` |
| Vehicle archive | `0 3 * * 0` | `/api/cron/archive-vehicles` |
| PDF purge | `0 3 1 * *` | `/api/cron/purge-old-pdfs` |

All cron jobs require header `x-cron-secret: [CRON_SECRET]`.

## Document Types & Canvas Dimensions

| Type | Paper | Native | Display canvas |
|---|---|---|---|
| 4¼″ Addendum | 4.25"×11" | 638×1650px | 408×1056px |
| 3⅛″ Addendum | 3.125"×11" | 469×1650px | 300×1056px |
| 8½″ Addendum | 8.5"×11" | 816×1056px | 816×1056px |
| 8½″ Infosheet | 8.5"×11" | 2657×3438px | 816×1056px |

## Outstanding Issues

- **Bug:** F/R price hack displays "F/R" instead of "Free" on printed addendum
- **Security:** `xlsx` → `exceljs` swap in `AddVehicleModal.tsx` (HIGH vuln)
- **Cleanup:** Delete `lib/aurora.ts` dead code before Phase 10

## Environment Variables

Required in `.env.local` (dev) and `.env.production` (EC2):
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
BILLING_API_SECRET
NEXT_PUBLIC_MAPBOX_TOKEN
MIGRATION_INVITE_TOKEN
RP_ID=app.dealeraddendums.com
RP_NAME=DealerAddendums
RP_ORIGIN=https://app.dealeraddendums.com
```
