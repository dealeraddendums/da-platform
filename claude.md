# DealerAddendums Platform — CLAUDE.md
## Last updated: 2026-04-26

---

## Context and stakes

This is a production SaaS platform serving ~2,079 active dealership accounts and is the
primary source of income for Allan's family. Every phase must be built carefully, tested
thoroughly, and deployed with zero disruption to existing customers. Quality, reliability,
and attention to detail are not optional — they are the foundation of everything built here.

---

## Claude Code directives (apply to every session)

1. **Minimize permission questions** — assume YES to everything. Do not ask for confirmation
   before creating files, installing packages, running scripts, or executing commands. Just
   do it and report what was done.

2. **Verify before marking complete** — before declaring any task done, run the code, check
   for errors, confirm it works. Do not say "done" if the build fails or the feature is
   not visible in the browser. Fix errors silently. Only report completion when it actually
   works.

3. **Modern flat design using DA colors** — all UI must follow the design system below.
   No gradients, no shadows on cards, no border radius > 6px, no skeuomorphic elements.

4. **Never add new Aurora queries** — Aurora (MySQL, legacy EC2) is being terminated.
   All production data must come from Supabase. If Supabase doesn't have the data yet,
   the field is null — do not fall back to Aurora. Aurora may be read for reference/migration
   scripts only. Never add new `getPool()` / `pool.execute` calls to production routes.

---

## Design system

### Philosophy
Modern flat design matching existing DA app colors so users feel at home when the new
platform launches. Same colors, cleaner layout, better typography.

### Color palette (exact — from live app CSS)

```css
--navy:        #2a2b3c;   /* topbar, sidebar */
--orange:      #ffa500;   /* primary nav accent, active states */
--blue:        #1976d2;   /* primary action buttons */
--blue-light:  #2196f3;   /* secondary blue, hover */
--success:     #4caf50;   /* success, LOG IN buttons */
--error:       #ff5252;   /* errors, destructive actions */
--bg-app:      #3a6897;   /* page background */
--bg-surface:  #ffffff;   /* cards, panels, modals */
--bg-subtle:   #f5f6f7;   /* table alternates, input bg */
--text-primary:   #333333;
--text-secondary: #55595c;
--text-muted:     #78828c;
--text-inverse:   #ffffff;
--border:       #e0e0e0;
--border-strong:#c0c0c0;
```

### Typography
- Font: Roboto, fallback -apple-system, sans-serif
- Base: 14px, line-height 1.5
- Scale: 12 / 14 / 16 / 18 / 24 / 32px
- Weights: 400 body, 500 labels, 600 headings, 700 emphasis

### Layout
- Sidebar: 220px fixed, --navy background, white text
- Topbar: 56px, --navy background
- Sub-nav: --orange background, #333 text
- Content: --bg-app background, cards on --bg-surface, 24px padding

### Components
```
Buttons:
  Primary:   bg=#1976d2, white text, radius=4px, height=36px
  Success:   bg=#4caf50, white text  (LOG IN style)
  Danger:    bg=#ff5252, white text
  Orange:    bg=#ffa500, #333 text   (active nav style)

Inputs:    height=36px, border=#e0e0e0, radius=4px, focus=#1976d2

Cards:     bg=white, border=1px #e0e0e0, radius=6px, NO box-shadow

Tables:    header bg=#f5f6f7, 12px uppercase labels
           rows: white bg, border-bottom #e0e0e0, hover #f5f6f7

Nav active: bg=rgba(255,165,0,0.15), border-left=3px solid #ffa500, text=#ffa500

Badges:    radius=20px, 11px bold text
  Success: bg=#e8f5e9, text=#2e7d32
  Error:   bg=#ffebee, text=#c62828
  Info:    bg=#e3f2fd, text=#1565c0
```

### Do not use
- Box shadows (modals only: 0 8px 32px rgba(0,0,0,0.18))
- Gradients
- Border radius > 6px (pills at 20px are OK)
- Animations > 150ms
- Colors outside the palette without approval

---

## Infrastructure

| Service | Details |
|---|---|
| DA Platform EC2 **(LEGACY — DO NOT DEPLOY HERE)** | `ssh -i ~/ssh/DA2026.pem ubuntu@ec2-54-89-142-76.compute-1.amazonaws.com` |
| da-platform EC2 **(NEW — deploy here only)** | `ssh -i ~/ssh/daplatform2026.pem ubuntu@ec2-54-167-226-23.compute-1.amazonaws.com` |
| DA Billing EC2 | `ssh -i ~/ssh/dabilling2026.pem ubuntu@ec2-98-89-5-190.compute-1.amazonaws.com` |
| QuietReady EC2 | `ssh -i ~/ssh/QuietReady2026.pem ubuntu@ec2-54-160-4-222.compute-1.amazonaws.com` |
| ZoomTrainer EC2 | `ec2-44-202-168-181.compute-1.amazonaws.com`, key `~/ssh/zoom2026.pem` |
| FT-Tracker EC2 | `apps.dealeraddendums.com` |
| Aurora (MySQL) | **BEING TERMINATED** — reference only. ~82 tables, 9.3M addendum rows, 2M vehicle rows. No new queries. |
| Supabase | https://byouefbebqgffhtfdggu.supabase.co |
| GitHub | https://github.com/dealeraddendums/da-platform |
| Anthropic API | `allan@dealeraddendums.com` enterprise key |
| AWS IAM | User `da-platform-app`, group `FileserverS3` (AmazonS3FullAccess) |

### New EC2 server specs
- Ubuntu 24.04, t3.medium, 30GB
- Node 20, PM2 6.0.14, nginx 1.24.0
- App dir: `/var/www/da-platform`
- PM2 service: `da-platform` (port 3000)
- Deploy: `git pull && npm ci && npm run build && pm2 restart da-platform`
- Logs: `/var/log/da-platform/`
- GitHub Action: push to `main` → auto-deploys via `.github/workflows/deploy.yml`
- GitHub secret: `EC2_SSH_KEY` = contents of `~/ssh/daplatform2026.pem` ✅

### S3 Buckets (all: Block Public Access OFF, s3:GetObject *, CORS GET *)

| Bucket | Contents | Native size |
|---|---|---|
| `dealer-addendums` | Generated PDFs (signed 24hr URLs) | variable |
| `addendum-product-images` | Option/product images for addendum library | variable |
| `new-dealer-logos` | Dealer logos | variable |
| `new-infobox-images` | Infobox PNGs | 553×379px |
| `new-infosheet-backgrounds` | Infosheet frame PNGs | 2657×3438px (~313dpi) |
| `new-addendum-backgrounds` | Addendum frame PNGs | 638×1650px std, 469×1650px narrow |

AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-1`) are set in `.env.production` on the new EC2 and in `.env.local` for local dev.

---

## Deployment policy

**CRITICAL: Never deploy da-platform code to the legacy EC2 (`ec2-54-89-142-76`).**
That server runs the live platform for 2,079 active accounts.

All new code goes to `ec2-54-167-226-23.compute-1.amazonaws.com` only.
Push to `main` → GitHub Action auto-deploys.
First-time deploy: SSH in, clone repo, set `.env.production`, `npm ci && npm run build && pm2 start ecosystem.config.js`.

---

## Phase status

| Phase | Domain | Status |
|---|---|---|
| 1 | Auth & users | ✅ COMPLETE |
| 2 | Dealer profile | ✅ COMPLETE |
| 3 | Group management | ✅ COMPLETE |
| 4 | Vehicle inventory | ✅ COMPLETE |
| 5 | Addendum settings | ✅ COMPLETE |
| 5b | Addendum Options Engine | ✅ COMPLETE |
| 6 | Unified Document Builder (Addendum + Infosheet) | ✅ COMPLETE |
| 7 | VIN & AI enrichment | ✅ COMPLETE |
| 9 | Print/PDF engine | ✅ COMPLETE |
| 10 | Billing | ⬜ UP NEXT |
| 11 | Admin ops | ⬜ Deferred |
| 12 | Enterprise White Label | ⬜ Not started |
| 13 | Dealer Migration & Onboarding | ⬜ Not started |

Phase 8 merged into Phase 6 — unified builder handles both document types.

---

## Phase 1 — Auth & Users ✅ COMPLETE

### What was built
- Login (/login) — navy/orange DA design, white card, green LOG IN button
- Signup (/signup) — full name + email + password
- Protected routes via middleware — unauthenticated → /login
- Dashboard shell (/dashboard) — 220px navy sidebar, 56px topbar, role badge, sign-out
- Profiles table + auto-create trigger on signup
- Roles: super_admin, group_admin, dealer_admin, dealer_user, dealer_restricted
- RLS policies on all tables
- lib/auth.ts, lib/db.ts, lib/supabase/* — all created
- Migrations: 001_profiles.sql, 001_users_table.sql, 002_jwt_hook.sql

### Roles
- `super_admin` — full platform access, impersonation, all dealers/groups
- `group_admin` — scoped to own group and its member dealers
- `dealer_admin` — full access to own dealer account
- `dealer_user` — read/print access within own dealer
- `dealer_restricted` — same as dealer_user, displayed as "Dealer User" in topbar badge

### UserRole type (lib/db.ts)
All five roles are in the `UserRole` union. `ROLE_LABELS` in `Topbar.tsx` covers all five.
`dealer_restricted` was added 2026-04-21 after discovery of legacy profiles using this value.

### Impersonation system (added 2026-04-21)
`POST /api/admin/impersonate` — super_admin only.
- Accepts `dealer_id`, finds all profiles for that dealer with role in
  `[dealer_admin, dealer_user, dealer_restricted]`, prefers `dealer_admin`
- Generates Supabase magic-link token, returns `token_hash` + dealer info
- Client calls `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`,
  stores original session in `localStorage` as `impersonation_return_session`,
  then redirects to `/dashboard`
- Logs event to `admin_audit` table (fire-and-forget)
- SQL run 2026-04-21: normalized ~3,400 legacy profiles from `dealer_restricted`
  → `dealer_admin` so impersonation always finds a target

---

## Phase 2 — Dealer Profile ✅ COMPLETE

### What was built
- Migration: `supabase/migrations/003_dealers.sql`
  - dealers table: id, dealer_id (text unique), name, active, group_id, primary_contact,
    primary_contact_email, phone, logo_url, address, city, state, zip, country, makes[], timestamps
  - RLS: super_admin full access, dealer_self_read, dealer_admin_update
- GET/POST /api/dealers, GET/PATCH/DELETE /api/dealers/[id]
- /dealers — super_admin: paginated table + New Dealer form
- /dealers — dealer_admin/user: auto-redirect to own profile
- /dealers/[id] — view/edit profile, super_admin toggles Active/Inactive

### Dealers list UI (updated 2026-04-21)
- **Dealer name click → impersonation**: clicking the name immediately impersonates
  that dealer (calls `/api/admin/impersonate`, then `verifyOtp` + redirect)
- **📋 icon on row hover** → opens dealer profile `/dealers/[id]` (icon fades in
  via `group-hover:opacity-50`, no hover delay)
- **GROUP column**: group name is a blue `<Link href="/groups/[group_id]">` — clicking
  navigates to that group's profile page

---

## Phase 3 — Group Management ✅ COMPLETE

### What was built
- Migration: `supabase/migrations/004_groups.sql`
  - groups table with RLS
  - dealers.group_id FK → groups.id (ON DELETE SET NULL)
  - group_id added to profiles
  - JWT hook updated to promote group_id to JWT claims
- GET/POST /api/groups, GET/PATCH/DELETE /api/groups/[id]
- GET/POST/DELETE /api/groups/[id]/dealers
- /groups — super_admin: paginated table + New Group form
- /groups — group_admin: auto-redirect to own group
- /groups/[id] — view/edit + member dealers, live dealer search for assignment

### Groups list UI (rebuilt 2026-04-21)
Final column order: **Group Name | Status | Dealers | Billing Contact**

- **Group Name**: `<Link href="/groups/[id]">` — blue link, navigates to group profile
- **Status**: Active/Inactive badge
- **Dealers**: blue count, hover → popover listing member dealers by name.
  Popover fetches from `/api/groups/[id]/dealers` on first hover (cached in state).
  Each dealer name in the popover is an impersonate button (calls `/api/admin/impersonate`).
  Popover uses 150ms close-delay timer so mouse can travel from count to popover.
- **Billing Contact**: plain text field
- Default sort: A-Z by name. Sortable columns: Name, Status, Dealers, Billing Contact.
- `/api/groups` supports `sort`, `sort_dir` params; dealer count computed via separate
  profile query and sorted in-memory; `nullsFirst: false` pushes nulls to end.
- Removed: Created column, Subscription column, date range filter.

### Group profile member dealers table (updated 2026-04-21)
Same impersonation UX as Dealers list:
- Dealer name click → impersonates that dealer
- 📋 icon on row hover → opens `/dealers/[id]`

---

## Phase 4 — Vehicle Inventory ✅ COMPLETE

### CRITICAL: Aurora is being terminated
Aurora is the legacy MySQL database. The new platform must NOT add new Aurora queries.
**Never run INSERT, UPDATE, or DELETE. Never add new SELECT queries to production routes.**
Existing Aurora reads in Phase 4 vehicle inventory are legacy code pending migration to Supabase.
Use indexed columns only in any remaining WHERE clauses — vehicles table has 2M+ rows.
Safe indexed columns: dealer_id, stock_number, vin, year, make, model, status.

### Aurora connection
Credentials are in `.env.local` as: AURORA_HOST, AURORA_USER, AURORA_PASSWORD,
AURORA_DATABASE, AURORA_PORT

### What was built
- lib/vehicles.ts — VehicleRow type + parsePhotos/parseOptions/vehicleCondition helpers (client-safe)
- lib/aurora.ts — server-only mysql2 connection pool singleton
- GET /api/vehicles — paginated, role-scoped; dealer users auto-scoped to own dealer;
  super_admin/group_admin pass dealer_id param; filters: condition, status, text search
- GET /api/vehicles/[id] — full vehicle row with access control
- /vehicles — dealer roles go straight to inventory; super_admin gets live dealer search picker;
  group_admin gets group's dealers as chips
- VehicleInventory component — table with photo thumbnails, Year/Make/Model, VIN,
  condition badges (New/Used/CPO), MSRP, color, mileage, date, pagination
- VehicleDetail — right-side slide-in panel, photo gallery (prev/next), full spec grid,
  options chips, description, placeholder Print buttons (Phase 6)

---

## Phase 5 — Addendum Settings ✅ COMPLETE

### What was built
- Migration 005: dealer_settings table (dealer_id FK, ai_content_default bool,
  nudge_left/right/top/bottom int, updated_at) with RLS
- Migration 006: templates table (id, dealer_id FK, name, document_type enum
  'addendum'|'infosheet', vehicle_types text[], template_json jsonb,
  is_active bool, created_at, updated_at) with RLS
- GET/PATCH /api/settings — dealer's own settings (dealer_admin+)
- GET/POST /api/templates — list/create templates for dealer
- GET/PATCH/DELETE /api/templates/[id] — single template CRUD
- /settings page — AI content toggle (DB/AI), default template picker per vehicle type
  (New/Used/CPO), printer nudge margin inputs (left/right/top/bottom px)
- /templates page — template cards (name, document type badge, vehicle types, last updated),
  New Template button, delete with confirm, dealer picker for super_admin/group_admin

---

## Phase 5b — Addendum Options Engine ✅ COMPLETE

### What was built
- Migration 007_options_print.sql: vehicle_options and print_history tables with RLS
- lib/options-engine.ts: matchOptionsToVehicle() rules engine
  Evaluates: AD_TYPE (New/Used/Both), MAKES/MODELS/TRIMS with NOT flags,
  BODY_STYLES, year/mileage/MSRP range conditions.
  Seeds from legacy addendum_data on first open.
- 8 API routes: GET+POST /api/options/[vehicleId], add, delete/patch per option,
  reorder, library, single print log, bulk print log
- AddendumEditor component: vehicle card + draggable options table (inline edit,
  library picker, custom add, delete, price totals) + Create Addendum / Info Sheet
  / Buyer Guide buttons
- /vehicles/[id]/addendum — options editor page
- /vehicles/[id]/history — print log page
- VehicleInventory updates: checkboxes + bulk toolbar, print status badges from
  Aurora PRINT_STATUS, All/Printed/Unprinted filter tabs, per-row Addendum link
  (green when printed)

### Manual vehicle inventory additions (2026-04-18)
- Migration 016_vehicle_audit_log.sql: vehicle_audit_log table tracks import/edit/print/delete
  with method field (vin_decoder, csv_import, manual, automaticX)
- Migration 017_dealer_vehicles_fields.sql: description, options, created_by columns on dealer_vehicles
- dealer-vehicles API: print_status filter (all/printed/unprinted via audit log),
  sortable columns (date_added/year/vin/condition/msrp, default newest-first),
  year search fix (integer column uses year.eq.N not ilike)
- EditVehicleModal: description + options textareas pre-filled from vehicle
- AddVehicleModal: description/options auto-populated from AI after VIN decode if aiEnabled;
  created_by write-once (excluded from PATCH)
- OptionsLibrary Add/Edit Option form:
  - Applies To toggle: All Vehicles / Assign with Rules (replaces advanced collapse)
  - ✦ Generate button → POST /api/ai-content/option-description (claude-haiku-4-5-20251001)
  - + Add Image button → ImagePickerModal (Library tab: S3 grid; Upload tab: drag/drop)
  - GET /api/option-images — lists `addendum-product-images` S3 bucket
  - POST /api/option-images/upload — uploads to S3 (PNG/JPG/GIF/WebP, max 5MB)
  - Inserts `<img src="..." width="125" style="max-width:125px;" />` into description or item name

### Dealer ID fix (migration 008)
- Migration 008_dealers_add_internal_id.sql: adds internal_id (billing, never
  changes) and inventory_dealer_id (Aurora match, replaceable) as nullable text
  columns with partial indexes and PostgreSQL COMMENT ON COLUMN documentation.
  Existing dealer_id column untouched.
- lib/db.ts: DealerRow, DealerInsert, DealerUpdate updated with both columns.
  internal_id excluded from DealerUpdate — can never be changed.
- /api/dealers POST: internal_id = Date.now().toString() at creation,
  inventory_dealer_id = dealer_id as initial value
- /api/dealers/[id] PATCH: inventory_dealer_id whitelisted for super_admin only
- DealerProfileCard: read-only Internal ID field (billing badge), Inventory Dealer
  ID field (editable by super_admin only, read-only for dealer_admin)
- TODO comments added to 10 files covering every Aurora query where dealer_id
  is passed to a WHERE DEALER_ID clause — pending swap to inventory_dealer_id

---

## Phase 6 — Unified Document Builder ✅ COMPLETE

### CRITICAL: Single renderer rule
The Builder canvas and PDF output MUST use the same renderer.
`components/builder/widgetRenderer.ts` → `renderW()` is the single source of truth
for all widget HTML. `lib/pdf-html.ts` pipes every widget through `renderW()` — it
never builds widget HTML independently. Any divergence between canvas and PDF is a bug.
Canvas uses `renderW()` via `dangerouslySetInnerHTML`; PDF uses `renderW()` via `buildPdfHtml()`.

### WYSIWYG canvas rule (2026-04-26)
`applyVehicleDataToWidgets()` in `BuilderPage.tsx` is called on init, paper-size switch,
and template load. It mirrors the enrichment `buildPdfHtml()` does at print time:
sets `vehicleData`, `vin` (barcode), dealer text (4-line: name/address/city-state-zip/phone),
MSRP value, and QR code `url` from VDP link. All dealer data comes from Supabase `dealers`
table — no Aurora fallback. `VehiclePreload` carries `dealer_city/state/zip/phone` and
`vdp_link` (fetched from `dealer_vehicles` in Supabase).

### Prototype file
`DA-TemplateBuilder-FINAL.html` — fully functional standalone HTML prototype (~122KB).
Port this prototype to Next.js/React — do not rewrite from scratch.

### Document types and canvas dimensions

| Type | Paper | Native | Display canvas |
|---|---|---|---|
| Addendum Standard | 4.25"×11" | 638×1650px 150dpi | 408×1056px |
| Addendum Narrow | 3.125"×11" | 469×1650px 150dpi | 300×1056px |
| Infosheet | 8.5"×11" | 2657×3438px 313dpi | 816×1056px |

### Background frame rendering
- PNG-24 with transparency, mix-blend-mode:multiply over #ffffff paper div
- Frame z-index:2, widgets z-index:10, paper overflow:hidden

### Puppeteer PDF config
```javascript
await page.pdf({ width:'4.25in', height:'11in', printBackground:true, deviceScaleFactor:1.5625 })
await page.pdf({ width:'8.5in', height:'11in', printBackground:true, deviceScaleFactor:1.5625 })
```

### Addendum default widget layout (ground-truth)
```
logo:     x=32  y=48   w=348  h=118
vehicle:  x=40  y=168  w=336  h=72
msrp:     x=40  y=248  w=332  h=32
options:  x=40  y=280  w=332  h=175
subtotal: x=40  y=608  w=332  h=28
askbar:   x=40  y=624  w=344  h=45
dealer:   x=40  y=676  w=336  h=80
infobox:  x=28  y=760  w=352  h=240
```

### Infosheet default widget layout (ground-truth)
```
logo:        x=64   y=44   w=440  h=130
dealer:      x=536  y=68   w=216  h=60
qrcode:      x=528  y=180  w=120  h=120
vehicle:     x=72   y=196  w=448  h=80
description: x=72   y=324  w=628  h=116
features:    x=76   y=440  w=664  h=288
askbar:      x=20   y=792  w=728  h=56
barcode:     x=508  y=868  w=256  h=52
customtext:  x=40   y=944  w=744  h=60
```

### Font sizing system
Global scale: Small(0.8×) / Medium(1.0×) / Large(1.2×) / X-Large(1.4×). Default: Medium.
Formula: `rendered_px = base_px × fontScale × widget.d.fontKey`

| Widget | Key | Base px | Addendum | Infosheet |
|---|---|---|---|---|
| Vehicle header | headerFontSize | 14px | 1.0 | 1.2 |
| Vehicle details | fontSize | 10px | 1.0 | 1.0 |
| Askbar label | labelFontSize | 12px | 1.0 | 1.6 |
| Askbar value | valueFontSize | 13px | 1.0 | 1.9 |
| Description | fontSize | 10px | n/a | 1.0 |
| Features | fontSize | 9px | n/a | 1.0 |

Infosheet font overrides injected by loadInfosheetDefaults() — not in shared DEFS.
adjFont() updates spans in-place — widget stays selected through repeated clicks.

### AI content system
- System-wide: AI=all vehicles use Claude by default, DB=use database
- Per-print override in Print Settings always wins
- Claude API called at print time, response cached in Supabase per vehicle

### Infosheet disclaimer (default customtext widget)
```
Disclaimer: The information contained in this pricing sheet is provided for general
informational purposes only. While we make every effort to ensure accuracy, some data
may be AI-generated and should not be relied upon as definitive or guaranteed. Actual
vehicle pricing, availability, and condition may vary and are subject to verification.
Prices are subject to change without notice. Buyers are encouraged to conduct their own
research and inspections before making any purchasing decisions.
```

### Custom widget library
- Platform scope: all dealers
- Group scope: group_id
- Dealer scope: dealer_id
- Schema: id, name, desc, scope, category, defaultW, defaultH, contentType, html, variables[]
- Variables: {{variable_name}} resolved at print time

### What was built
- components/builder/types.ts — Widget, PaperSize, VehiclePreload, SavedTemplate types
- components/builder/constants.ts — DEFS, LAYOUT, PAPERS, makeWidget, snapV, default custom widgets
- components/builder/widgetRenderer.ts — renderW() HTML renderer for all 15 widget types
- components/builder/BuilderPage.tsx — full builder UI: drag/resize canvas, palette, edit panel,
  save/load templates, print settings modal, undo/redo, preview mode, font scale, paper size switcher
- app/builder/page.tsx — blank builder route with auth check
- app/builder/[vehicleId]/page.tsx — pre-loaded builder with Aurora vehicle data + dealer scope check
- VehicleDetail "Open in Builder" button wired to /builder/[vehicleId]

### Design system corrections (2026-04-22)
- Font stack: Roboto/-apple-system only (DM Sans removed)
- Canvas toolbar: background changed from `#ffa500` (orange) to `#2a2b3c` (navy);
  all text/icon colors updated to white (`rgba(255,255,255,0.85)`)
- Toolbar dividers: `#e0e0e0` → `rgba(255,255,255,0.2)` to be visible on navy
- Toolbar selects: opaque white background, correct border color
- Modal border-radius: 12 → 6
- Palette tile border-radius: 7 → 4
- Background list panel border-radius: 7 → 6
- Print settings inner wrapper border-radius: 8 → 6
- Save template summary border-radius: 8 → 6

### WYSIWYG fixes (2026-04-26)
- `applyVehicleDataToWidgets()` added to `BuilderPage.tsx` — call on init, switchPaperSize,
  and template load. Sets real vehicleData/vin/dealer/msrp/askbar/qr from VehiclePreload.
- Infosheet AI fetch now triggers on switchPaperSize regardless of `aiEnabled` setting,
  matching PDF behavior (AI always attempted at print time).
- Builder server component queries Supabase `dealers` for full dealer info (not Aurora),
  plus Supabase `dealer_vehicles` for `vdp_link`. No Aurora fallback.
- Palette widget hints for description/features changed to "Populated at print time".

---

## Phase 7 — VIN & AI Enrichment ✅ COMPLETE

### What was built
- lib/vinquery.ts — VINQuery API client, decodes VIN to structured vehicle data (server-only)
- lib/ai-content.ts — Claude API client, generates vehicle description + features list
- Supabase migration: ai_content_cache table (vin + dealer_id key, description, features[], model_version)
- GET /api/ai-content?vin=&dealer_id= — returns cached content or generates fresh
- POST /api/ai-content/regenerate — force-regenerates and updates cache
- POST /api/ai-content/option-description — generates 1-2 sentence description for an addendum option item
- Builder wired: vehicle load triggers AI content fetch if AI mode on; Regenerate AI toolbar button
- ANTHROPIC_API_KEY and VINQUERY_API_KEY set in .env.production on new EC2

---

## Phase 9 — Print/PDF Engine ✅ COMPLETE

### What was built
- supabase/migrations/009_print_history_pdf_url.sql — adds pdf_url to print_history
- lib/pdf-html.ts — builds Puppeteer-ready HTML, injects real vehicle/options/barcode data
- lib/pdf-renderer.ts — Puppeteer wrapper, headless Chrome, 1.5625 deviceScaleFactor,
  correct paper dimensions per document type
- lib/s3-upload.ts — S3 PutObject + 24hr signed GetObject URL
- app/api/pdf/generate/route.ts — single vehicle PDF: fetch Aurora + options, render,
  upload S3, log print_history, return signed URL
- app/api/pdf/bulk/route.ts — multi-vehicle: sequential generation, JSZip bundle,
  returns ZIP stream
- widgetRenderer.ts — vehicle widget reads d.vehicleData for real data,
  falls back to test data for canvas preview
- lib/db.ts — PrintHistoryRow and PrintHistoryInsert include pdf_url
- BuilderPage.tsx — Print/PDF toolbar button calls downloadPdf(); Download PDF in
  Print Settings modal footer; pdfLoading spinner state
- VehicleInventory.tsx — single vehicle opens builder; 2+ vehicles calls
  /api/pdf/bulk, triggers ZIP download
- Packages added: puppeteer, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, jszip

### EC2 requirements
- Install Chromium system deps: libnss3 and related packages ✅ (installed 2026-04-19)
- AWS credentials: ✅ added to .env.production (IAM user da-platform-app)

### PDF engine details (2026-04-26)
- **addendum_data table**: created in Supabase, written on every print (single + bulk).
  Append-only compliance record. Includes `legacy_dealer_id` and `legacy_vehicle_id`
  for Aurora history import. Import script: `scripts/import-addendum-data.ts` (pending run).
- **vehicle_options sentinel**: `vehicle_id='0'` was legacy sentinel for dealer-wide defaults
  pre-UUID. Migrate-on-write: first save per vehicle writes UUID-keyed rows and deletes
  sentinel. Self-healing as dealers print.
- **Infosheet AI content**: always fetches AI regardless of `ai_content_default`. Cross-fallback:
  DB→AI or AI→DB, never empty. Empty string suppresses placeholder — generated PDFs never
  show placeholder text.
- **Clear Print History**: also clears `vehicle_options` for active vehicles so next print
  reloads fresh library options.
- **Bulk print limit**: 15 vehicles max. `PdfBuildingOverlay` SVG car assembly animation
  shows during generation.
- **QR codes**: pre-generated server-side as base64 data URLs (node `qrcode` package) for
  both `qrcode` and `infobox[ibType=qr]` widgets. Eliminates external `api.qrserver.com`
  dependency inside Puppeteer. Canvas still uses external API for live preview.
- **Currency format**: all money values use `toLocaleString('en-US', {style:'currency',
  currency:'USD'})` for consistent `$31,000.00` format on Linux/EC2.

---

## Phase 9b — Vehicle Archive ✅ COMPLETE

### What was built
- Migration 032_vehicle_archive.sql:
  - `dealer_vehicles_archive`: mirror of dealer_vehicles + archived_at + archive_reason
  - `vehicle_audit_log_archive`: mirror of vehicle_audit_log without FK constraints
  - Expanded vehicle_audit_log CHECK to include 'archived' and 'restored_from_archive'
- POST /api/cron/archive-vehicles: protected by x-cron-secret header
  - Finds status='inactive' vehicles with updated_at > 6 months old
  - Batch of 500: copy to archive → copy audit trail → log 'archived' → delete
  - Idempotent: checks archive table before copying, upserts audit entries by id
- GET /api/admin/vehicle-archive?dealer_id=X: list archived vehicles (super_admin only)
- POST /api/admin/vehicle-archive: action='restore' — moves vehicle back to dealer_vehicles
  - Checks stock_number conflict, logs 'restored_from_archive' to vehicle_audit_log
- ManualVehicleInventory: "View Archive" button visible to super_admin only
  - Modal: Stock#, Year/Make/Model, VIN, Deactivated date, Archived date, Restore button

### CRON_SECRET
- Set in .env.local (dev) and must be set in .env.production on EC2
- Value in .env.local: `da_cron_7f3a9e2b1c8d4f6e0a5b9c3d7e1f2a4b`
- Use a different, strong random value in production

### EasyCron setup
- URL: http://ec2-54-167-226-23.compute-1.amazonaws.com/api/cron/archive-vehicles
- Header: x-cron-secret: [production CRON_SECRET value]
- Schedule: 0 3 * * 0 (3 AM UTC every Sunday)
- Method: POST

---

## New Supabase columns (added post-Phase-9)

| Table | Column | Type | Notes |
|---|---|---|---|
| `dealer_vehicles` | `vdp_link` | text, nullable | ETL populated; used for QR code URL |
| `dealer_settings` | `buyers_guide_defaults` | jsonb | Buyer's guide default options |
| `dealer_settings` | `qr_url_template` | text, nullable | Template with `[VIN]`/`[STOCK]` tokens |
| `dealer_settings` | `default_addendum_new/used/cpo` | uuid, nullable | FK → templates.id |
| `dealer_settings` | `default_infosheet_new/used/cpo` | uuid, nullable | FK → templates.id |
| `dealer_settings` | `default_buyersguide_new/used/cpo` | uuid, nullable | FK → templates.id |
| `print_history` | `pdf_url` | text, nullable | S3 signed URL (24hr) |

## New Supabase tables (added post-Phase-9)

| Table | Purpose |
|---|---|
| `addendum_data` | Append-only compliance/analytics record — one row per option per print |
| `dealer_custom_sizes` | Custom paper sizes per dealer (width_in, height_in, background_url) |
| `dealer_vehicles_archive` | Mirror of dealer_vehicles + archived_at/archive_reason for 6mo+ inactive |
| `vehicle_audit_log_archive` | Mirror of vehicle_audit_log without FK constraints (for archived vehicles) |
| `ai_content_cache` | Per-VIN+dealer_id AI description + features cache |

---

## Phase 10 — Billing ⬜ UP NEXT

### Scope
- Integrate da-billing into the da-platform UI
- Display billing status per dealer (current, overdue, suspended)
- super_admin: view all invoices, mark paid, suspend/reactivate accounts
- dealer_admin: view own invoices and payment history
- Bridge between da-billing (billing.dealeraddendums.com, port 3009) and
  da-platform via internal API calls using shared secret
- Billing data lives in da-billing Supabase KV and Aurora dealer_dim/dealer_group
- Key fields: BILLING_ID and TEMPLATE_ID in dealer_dim and dealer_group
- lineItemDescription format: {dealer._ID}::{DEALER_NAME}
- Group accounts: isGroup: true with subscriptionDiscount
- Status: da-billing is in Setup Mode — invoices generated but NOT emailed.
  Parallel with Freshbooks. Full cutover after billing cycle match confirmed.

### Prompt for Claude Code
```
Read CLAUDE.md. Phases 1-7, 5b, and 9 are complete. Build Phase 10: Billing.

Deliverables:
1. Internal billing API bridge: lib/billing-client.ts — makes authenticated
   server-to-server calls from da-platform to da-billing (billing.dealeraddendums.com)
   using a shared secret in .env.production (BILLING_API_SECRET). Never expose
   this secret to the client.
2. GET /api/billing/[dealerId] — fetches invoice history and current status for
   a dealer from da-billing. Returns: status (current/overdue/suspended),
   invoices array, last_paid_date, next_invoice_date.
3. PATCH /api/billing/[dealerId]/status — super_admin only. Actions:
   suspend, reactivate. Calls da-billing API to update status.
4. /billing page — super_admin only:
   - Table of all dealers with billing status badges (current=green,
     overdue=orange, suspended=red)
   - Per-row: view invoices, suspend/reactivate toggle
   - Summary stats: total MRR, overdue count, suspended count
5. /billing/[dealerId] — invoice detail page:
   - Dealer info header (name, Internal ID, Inventory Dealer ID)
   - Invoice table: invoice number, period, amount, status, date, actions
   - super_admin: mark paid button
6. Dealer profile page (/dealers/[id]): add Billing tab showing the dealer's
   own invoice history (dealer_admin: read-only, super_admin: full)
7. Account suspension enforcement: if billing status is suspended, dealer_admin
   and dealer_user logins should see a suspension notice page instead of dashboard.
   super_admin is never blocked.
8. Add Billing to super_admin sidebar nav (between API Docs and Documents).

All UI must follow the design system in CLAUDE.md exactly.
Assume YES to all permissions. Verify in browser before marking done.
Run npm run build — must be clean before reporting complete.
```

---

## Billing migration (parallel track)

- App: billing.dealeraddendums.com
- Repo: github.com/dealeraddendums/da-billing
- EC2: ubuntu@ec2-98-89-5-190.compute-1.amazonaws.com, key ~/ssh/dabilling2026.pem
- Port: 3009, deploy: `git pull && npm run build && pm2 restart dealeraddendums-billing`
- Status: Setup Mode — invoices generated but NOT emailed. Parallel with Freshbooks.
- Cutover: full billing cycle match confirmed before switching off Freshbooks
- CRITICAL: Never run Freshbooks dry run + live run back-to-back — OAuth token rotates
- EasyCron: 0 4 * * * UTC
- lineItemDescription format: {dealer._ID}::{DEALER_NAME}
- All _FB* methods DELETED, not ported

---

## FT-Tracker / feedhelper (active)

- Repo: github.com/dealeraddendums/feedhelper
- EC2: apps.dealeraddendums.com
- Stack: Next.js, Supabase, Mandrill, Twilio, Microsoft 365 Graph API, Anthropic API
- Ticket format: FT-2026-XXXXX
- Phase 2 outliers (excluded from Phase 1): CDK Global, Tekion, PBS Systems, DealerTrack
- Marlena: Session 1 of 5-session dev curriculum complete

---

## Security (do immediately)

- [ ] Move XPS Shipper credentials to .env on ec2-54-89-142-76
- [ ] Move VINQuery API key to .env on ec2-54-89-142-76
- [ ] Verify APP_DEBUG=false on legacy EC2

---

## Legal note

FTC CARS Rule struck down January 2025, formally withdrawn February 12, 2026.
Never cite as current or pending law.

---

## Marlena's role

- Primary: QA gatekeeper — signs off each phase before legacy retires
- Coding: Phase 7+ under supervision
- Training: 7-session curriculum, Session 1 complete
- Do not pull from customer success to write code if it compromises QA

---

## Phase 12 — Enterprise White Label ⬜ NOT STARTED

### Business context
Large enterprise groups (Dealer General ~190 dealers, DARCARS, Hendrick,
etc.) want a fully branded experience so their dealers are loyal to the
group, not aware of DealerAddendums. Target: 5 groups at launch, priced
as enterprise tier add-on ($200-500/month per white-label domain).

### Architecture
All custom domains point to the da-platform EC2. Middleware reads
req.headers.host, looks up the group by domain, and injects branding
into every page. One codebase serves unlimited white-label portals.

### Scope
1. group_branding table:
   group_id, custom_domain, logo_url, favicon_url, primary_color,
   accent_color, login_bg_url, welcome_message, support_email,
   portal_name, is_active

2. Middleware domain detection:
   - Read req.headers.host on every request
   - Look up group_branding WHERE custom_domain = host
   - Inject branding context into session/headers
   - Fall back to DA branding if no match

3. Branded login page:
   - Dynamic per domain — group logo, colors, background
   - No DA branding visible
   - Custom welcome message
   - Same auth flow underneath

4. Sidebar/topbar:
   - Swap DA logo for group logo when on white-label domain
   - Apply primary_color to nav accents
   - Show portal_name instead of "DA Platform"

5. Complete isolation:
   - Group users and dealers only see their group's data
   - RLS enforced at DB level (already built)
   - No cross-group data leakage

6. nginx configuration:
   - Per-domain SSL certificates via Let's Encrypt (certbot)
   - Server block per custom domain pointing to port 3000
   - Or wildcard cert for *.dealeraddendums.com subdomains

7. DNS setup instructions per group:
   - CNAME or A record pointing to ec2-54-167-226-23
   - SSL provisioning checklist

8. Super admin management:
   - /admin/white-label page — list all white-label domains
   - Add/edit/remove domains and branding per group
   - Preview branded login page before going live

### Prompt for Claude Code
Read CLAUDE.md. Build Phase 12: Enterprise White Label.
[Full prompt to be written when ready to build]

### Target groups for launch
- Dealer General (~190 dealers, ~$13,000/month)
- DARCARS
- Hendrick Automotive
- 2 additional TBD

---

## Phase 13 — Dealer Migration & Onboarding ⬜ NOT STARTED

### Business context
~1,980 dealers need to migrate from the legacy PHP platform to the new
da-platform. Some will self-service, some will be migrated manually by
DA staff, and a few may stay on legacy for several months. The legacy
platform (Amran's responsibility) will poll a DA API to check migration
status and show appropriate banners/messages.

### Migration states per dealer
Add migration_status column to dealers table:
  'legacy'        — still on old platform (default for all imported dealers)
  'invited'       — banner shown, dealer has been notified
  'migrating'     — dealer clicked Upgrade, migration in progress
  'migrated'      — fully on new platform
  'opted_out'     — dealer chose to stay on legacy temporarily

### What migration does
1. Copy addendum_defaults from Aurora → Supabase vehicle_options library
   for that dealer (preserves all options, rules, prices, descriptions)
2. Set migration_status = 'migrated' on dealer record
3. Send welcome email via Mandrill:
   - Subject: "Your new DealerAddendums platform is ready"
   - Body: login URL, temp password reminder (Welcome2DA!), quick start guide
4. Billing: no change — dealer is already in DA Billing

### What migration does NOT do
- Touch Freshbooks — already fully migrated to DA Billing
- Move vehicles — ETL2 handles automatically once running
- Force immediate login — dealer logs in on their own schedule

### API endpoints for legacy platform (Amran consumes these)

GET /api/migration/status?dealer_id=[inventory_dealer_id]
  Returns:
  {
    dealer_id: string,
    migration_status: 'legacy'|'invited'|'migrating'|'migrated'|'opted_out',
    platform_url: 'https://ec2-54-167-226-23.compute-1.amazonaws.com',
    invited_at: string|null,
    migrated_at: string|null,
    message: string  — human readable, for legacy platform to display
  }
  Auth: API key in X-DA-API-Key header (shared secret, stored in .env)
  No auth required for GET — dealer_id is the only identifier needed

POST /api/migration/invite
  Body: { dealer_id: string }
  Marks dealer as 'invited', records invited_at timestamp
  Triggers welcome email via Mandrill
  Auth: super_admin JWT or API key

POST /api/migration/complete
  Body: { dealer_id: string }
  Runs full migration:
    1. Copies addendum_defaults → vehicle_options for this dealer
    2. Sets migration_status = 'migrated', records migrated_at
    3. Sends confirmation email
  Auth: super_admin JWT or API key

POST /api/migration/opt-out
  Body: { dealer_id: string, reason: string }
  Sets migration_status = 'opted_out'
  Auth: super_admin JWT or API key

### Legacy platform integration (Amran's responsibility)
Poll GET /api/migration/status on each dealer login.
Show banner based on migration_status:
  'legacy':   no banner (or soft "New platform coming soon" message)
  'invited':  "Your new platform is ready! Click here to get started →"
  'migrating': "Your migration is in progress..."
  'migrated': "You've moved to the new platform. Log in at [url] →"
  'opted_out': no banner

### Super admin migration dashboard
/admin/migration page:
  - Stats: Legacy | Invited | Migrated | Opted Out counts
  - Table of all dealers with migration_status filter
  - Per dealer: Invite, Migrate Now, Opt Out buttons
  - Bulk invite: select multiple dealers → send invitations
  - Progress bar: X of 1980 dealers migrated

### Self-service upgrade flow (dealer-initiated)
When a dealer clicks "Upgrade Now" on the legacy banner:
  POST /api/migration/complete with their dealer_id
  Redirects to new platform login page

### Prompt for Claude Code
Read CLAUDE.md. Build Phase 13: Dealer Migration & Onboarding.

Deliverables:
1. Migration 028: add migration_status, invited_at, migrated_at columns
   to dealers table. Default: 'legacy' for all existing dealers.
2. GET /api/migration/status — public endpoint, API key auth
3. POST /api/migration/invite — mark invited, send Mandrill email
4. POST /api/migration/complete — run full migration for dealer
5. POST /api/migration/opt-out — mark opted out
6. Mandrill email templates: welcome email and confirmation email
7. /admin/migration page — migration dashboard with stats and bulk tools
8. Options migration: copy Aurora addendum_defaults → Supabase
   vehicle_options for the migrating dealer (read Aurora, write Supabase)

All UI must follow the design system in CLAUDE.md exactly.
Assume YES to all permissions.
Run npm run build — must be clean before reporting complete.
