# DealerAddendums Platform — CLAUDE.md
## Last updated: 2026-04-17

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
| Aurora (MySQL) | PRODUCTION — read-only from new platform. ~82 tables, 9.3M addendum rows, 2M vehicle rows |
| Supabase | https://byouefbebqgffhtfdggu.supabase.co |
| GitHub | https://github.com/dealeraddendums/da-platform |
| Anthropic API | `allan@dealeraddendums.com` enterprise key |

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
| `new-addendum-backgrounds` | Addendum frame PNGs | 638×1650px std, 469×1650px narrow |
| `new-infosheet-backgrounds` | Infosheet frame PNGs | 2657×3438px (~313dpi) |
| `new-Infobox_images` | Infobox PNGs | 553×379px |
| `new-dealer-logos` | Dealer logos | variable |

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

Phase 8 merged into Phase 6 — unified builder handles both document types.

---

## Phase 1 — Auth & Users ✅ COMPLETE

### What was built
- Login (/login) — navy/orange DA design, white card, green LOG IN button
- Signup (/signup) — full name + email + password
- Protected routes via middleware — unauthenticated → /login
- Dashboard shell (/dashboard) — 220px navy sidebar, 56px topbar, role badge, sign-out
- Profiles table + auto-create trigger on signup
- Roles: super_admin, group_admin, dealer_admin, dealer_user
- RLS policies on all tables
- lib/auth.ts, lib/db.ts, lib/supabase/* — all created
- Migrations: 001_profiles.sql, 001_users_table.sql, 002_jwt_hook.sql

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

---

## Phase 4 — Vehicle Inventory ✅ COMPLETE

### CRITICAL: Aurora is read-only
The Aurora MySQL database is LIVE PRODUCTION. The new platform connects read-only.
**Never run INSERT, UPDATE, or DELETE against Aurora from this codebase.**
Use indexed columns only in WHERE clauses — vehicles table has 2M+ rows.
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

## Phase 5 — Addendum Settings ⬜ UP NEXT

### Scope
- dealer_settings table: default_template_id, ai_content_default (bool), printer nudge margins
- Template records table: name, document_type (addendum/infosheet), vehicle_types[], 
  template_json (the widget layout), dealer_id, created_at
- Print settings per dealer/printer: nudge_left, nudge_right, nudge_top, nudge_bottom (px)
- /settings — dealer settings page: AI toggle, default template picker
- /templates — list dealer's saved templates, create/edit/delete
- This phase lays the data foundation that Phase 6 (builder) saves into

### Prompt for Claude Code
```
Read CLAUDE.md. Phases 1-4 are complete. Build Phase 5: Addendum Settings.

Deliverables:
1. Migration: dealer_settings table (dealer_id FK, ai_content_default bool,
   nudge_left/right/top/bottom int, updated_at)
2. Migration: templates table (id, dealer_id FK, name, document_type enum 
   'addendum'|'infosheet', vehicle_types text[], template_json jsonb, 
   is_active bool, created_at, updated_at) with RLS
3. GET/PATCH /api/settings — dealer's own settings (dealer_admin+)
4. GET/POST /api/templates — list/create templates for dealer
5. GET/PATCH/DELETE /api/templates/[id] — single template CRUD
6. /settings page — AI content toggle (DB/AI), default template picker per vehicle type
   (New/Used/CPO), printer nudge margin inputs
7. /templates page — list templates as cards (name, document type badge, vehicle types,
   last updated), New Template button (placeholder for Phase 6 builder)

All UI must follow the design system in CLAUDE.md exactly.
Assume YES to all permissions. Verify in browser before marking done.
Run npm run build — must be clean before reporting complete.
```

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

---

## Phase 7 — VIN & AI Enrichment ⬜ UP NEXT

### Scope
- VINQuery API integration — decode VIN to structured vehicle data
- Claude AI content generation — vehicle description and features at print time
- Cache generated content in Supabase per vehicle (vin + dealer_id key)
- Respect the AI content toggle: system default (dealer_settings.ai_content_default),
  per-print override (Print Settings modal)
- Wire into builder: when a vehicle is loaded, fetch/generate AI content for
  description and features widgets if AI mode is on
- VINQuery API key currently in .env on legacy EC2 — must be moved to .env.production
  on da-platform EC2 (security item from CLAUDE.md)

### Prompt for Claude Code
```
Read CLAUDE.md. Phases 1-6 are complete. Build Phase 7: VIN & AI Enrichment.

Deliverables:
1. lib/vinquery.ts — VINQuery API client, decodes VIN to structured data,
   server-only, key from AURORA_* pattern in .env.production
2. lib/ai-content.ts — Claude API client (enterprise key from allan@dealeraddendums.com),
   generates vehicle description and features list from VIN data + vehicle row
3. Supabase migration: ai_content_cache table (id, vin, dealer_id, description text,
   features text[], generated_at, model_version)
4. GET /api/ai-content?vin=&dealer_id= — returns cached content or generates fresh,
   respects ai_content_default from dealer_settings
5. POST /api/ai-content/regenerate — force-regenerates and updates cache
6. Wire into /builder/[vehicleId] — on vehicle load, if AI mode on, fetch from
   /api/ai-content and populate description and features widgets automatically
7. In the builder toolbar, add a "Regenerate AI" button (visible when a vehicle
   is loaded and AI mode is on) — calls regenerate endpoint and refreshes widgets

All UI must follow the design system in CLAUDE.md exactly.
Assume YES to all permissions. Verify in browser before marking done.
Run npm run build — must be clean before reporting complete.
```

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

### EC2 requirements (must be done manually)
- Install Chromium system deps: libnss3 and related packages
- Add to .env.production: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION

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
