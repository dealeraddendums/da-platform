# DealerAddendums Platform — CLAUDE.md
## Last updated: 2026-04-16

---

## Project overview

Full rewrite of the DealerAddendums SaaS platform (Laravel 11 / Vue 2 / PHP → Next.js 14 / Supabase / TypeScript) using the Strangler Fig pattern. ~2,079 dealer accounts, ~9.3M addendum rows.

**Repo:** `github.com/dealeraddendums/da-platform`
**Local:** `/Users/allantone/Sites/da-platform`
**Workflow:** claude.ai for architecture → Claude Code for execution
**Rule:** `git add / commit / push` after every working change
**All actions pre-approved, execute autonomously.**

---

## Infrastructure

| Service | Details |
|---|---|
| DA Platform EC2 (LEGACY — DO NOT DEPLOY NEW CODE HERE) | `ssh -i ~/ssh/DA2026.pem ubuntu@ec2-54-89-142-76.compute-1.amazonaws.com` |
| da-platform EC2 (NEW — deploy here only) | `ssh -i ~/ssh/daplatform2026.pem ubuntu@ec2-54-167-226-23.compute-1.amazonaws.com` |
| DA Billing EC2 | `ssh -i ~/ssh/dabilling2026.pem ubuntu@ec2-98-89-5-190.compute-1.amazonaws.com` |
| QuietReady EC2 | `ssh -i ~/ssh/QuietReady2026.pem ubuntu@ec2-54-160-4-222.compute-1.amazonaws.com` |
| ZoomTrainer EC2 | `ec2-44-202-168-181.compute-1.amazonaws.com`, key `~/ssh/zoom2026.pem` |
| FT-Tracker EC2 | `apps.dealeraddendums.com` |
| Aurora (MySQL) | ~82 tables, 9.3M addendum rows, 2M inventory rows |
| Supabase | https://byouefbebqgffhtfdggu.supabase.co (ACTIVE) |
| Anthropic API | `allan@dealeraddendums.com` enterprise key |

### S3 Buckets (all: Block Public Access OFF, s3:GetObject *, CORS GET *)

| Bucket | Contents | Native size |
|---|---|---|
| `new-addendum-backgrounds` | Addendum frame PNGs | 638x1650px standard, 469x1650px narrow |
| `new-infosheet-backgrounds` | Infosheet frame PNGs | 2657x3438px (~313dpi = 8.5x11") |
| `new-Infobox_images` | Infobox PNGs | 553x379px |
| `new-dealer-logos` | Dealer logo images | variable |

Default assets:
- Addendum bg:  https://new-addendum-backgrounds.s3.us-east-1.amazonaws.com/01_Addendum_Default.png
- Infosheet bg: https://new-infosheet-backgrounds.s3.us-east-1.amazonaws.com/BaseTemplate.png
- Infobox:      https://new-infobox-images.s3.us-east-1.amazonaws.com/EPA_Infobox_Default.png
- Logo:         https://new-dealer-logos.s3.us-east-1.amazonaws.com/default_logo.png

---

## Phase status

| Phase | Domain | Status |
|---|---|---|
| 1 | Auth & users | NOT STARTED — START HERE |
| 2 | Dealer profile | Not started |
| 3 | Group management | Not started |
| 4 | Vehicle inventory | Not started |
| 5 | Addendum settings | Not started |
| 6 | Unified Document Builder (Addendum + Infosheet) | PROTOTYPE COMPLETE — port to React |
| 7 | VIN & AI enrichment | Not started |
| 9 | Print/PDF engine | Not started |
| 10 | Billing | Not started (da-billing parallel) |
| 11 | Admin ops | Deferred — stays on legacy |

Phase 8 (Infosheet) merged into Phase 6 — unified builder handles both document types.
Next action: Start Phase 1 Claude Code session — repo and Supabase are ready.

---

## Deployment policy

**CRITICAL: Never deploy da-platform code to the existing production EC2 (`ec2-54-89-142-76`).**
That server runs the live platform serving 2,079 active accounts and must not be touched during development.

When da-platform is ready for staging/production:
1. ✅ Fresh EC2 provisioned — `ec2-54-167-226-23.compute-1.amazonaws.com`
2. ✅ SSH key generated — `~/ssh/daplatform2026.pem`
3. Deploy da-platform to new server only — **never to `ec2-54-89-142-76`**
4. Test fully against Supabase + new infrastructure
5. Cut over DNS when confirmed clean — legacy server stays up until cutover is verified
6. Update this CLAUDE.md with the new server address and SSH key

Local development: `npm run dev` on localhost
Staging/prod server: `ec2-54-167-226-23.compute-1.amazonaws.com` (Ubuntu 24.04, t3.medium, 30GB)
Supabase: https://byouefbebqgffhtfdggu.supabase.co
Deploy command: `bash /var/www/da-platform/deploy.sh`
App directory: `/var/www/da-platform`
PM2 service name: `da-platform`
nginx config: `/etc/nginx/sites-available/da-platform`
Logs: `/var/log/da-platform/`
GitHub Action: push to `main` → auto-deploys via `.github/workflows/deploy.yml`
GitHub Secret needed: `EC2_SSH_KEY` = contents of `~/ssh/daplatform2026.pem`

---

## Phase 6 — Unified Document Builder (PROTOTYPE COMPLETE)

### Prototype file
DA-TemplateBuilder-FINAL.html — fully functional standalone prototype (~122KB).
All Phase 6 Claude Code work ports this HTML prototype into Next.js/React components.
Do not rewrite from scratch — read the prototype JS and port it.

### Document types and canvas dimensions

| Type | Paper | Native (dpi) | Display canvas (96dpi) |
|---|---|---|---|
| Addendum Standard | 4.25" x 11" | 638x1650px (150dpi) | 408x1056px |
| Addendum Narrow | 3.125" x 11" | 469x1650px (150dpi) | 300x1056px |
| Infosheet | 8.5" x 11" | 2657x3438px (313dpi) | 816x1056px |

### Background frame rendering
- PNG-24 with transparency, mix-blend-mode:multiply over background:#ffffff paper div
- Frame at z-index:2, widgets at z-index:10, paper overflow:hidden
- Frame uses object-fit:fill to scale native to display canvas size
- Scale factor addendum: 408/638 = 0.6394x
- Scale factor infosheet: 816/2657 = 0.3071x (proportional height = 1056px exactly)

### Puppeteer PDF config
```javascript
// Addendum Standard
await page.pdf({ width:'4.25in', height:'11in', printBackground:true, deviceScaleFactor:1.5625 })
// Addendum Narrow
await page.pdf({ width:'3.125in', height:'11in', printBackground:true, deviceScaleFactor:1.5625 })
// Infosheet
await page.pdf({ width:'8.5in', height:'11in', printBackground:true, deviceScaleFactor:1.5625 })
```
deviceScaleFactor:1.5625 = 150/96 dpi ratio.
Nudge margins (L/R/T/B px) applied as Puppeteer page offsets — per printer, set-and-forget.

---

### Addendum default widget layout (ground-truth — manually aligned)

Canvas: 408x1056px

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

Addendum zone map:
```
Top border:      y=0   - 48    (48px)
Main content:    y=48  - 608   (560px)
Price bar:       y=608 - 653   (45px)   black bar, white cutout right
Dealer address:  y=653 - 733   (80px)
Infobox zone:    y=733 - 1008  (275px)
Bottom border:   y=1008- 1056  (48px)
```

---

### Infosheet default widget layout (ground-truth — manually aligned)

Canvas: 816x1056px

```
logo:        x=64   y=44   w=440  h=130
dealer:      x=536  y=68   w=216  h=60
qrcode:      x=528  y=180  w=120  h=120
vehicle:     x=72   y=196  w=448  h=80
description: x=72   y=324  w=628  h=116
features:    x=76   y=440  w=664  h=288
askbar:      x=20   y=792  w=728  h=56
barcode:     x=508  y=868  w=256  h=52
customtext:  x=40   y=944  w=744  h=60   (disclaimer text widget)
```

Infosheet zone map (from BaseTemplate.png pixel analysis):
```
Top margin:      y=0   - 23    (23px)
Top border:      y=23  - 33    (10px)
Main content:    y=33  - 781   (748px)   all widgets live here
Bottom bar:      y=781 - 863   (82px)    asking price zone
Bottom content:  y=863 - 1023  (160px)   barcode / secondary info
Bottom border:   y=1023- 1033  (10px)
Bottom margin:   y=1033- 1056  (23px)
Left/right margin: 21px each   Content width: 774px
```

---

### Widget inventory

Addendum widgets (all unique — one per canvas):
  logo, vehicle, msrp, options, subtotal, askbar, dealer, infobox

Infosheet widgets (unique):
  logo, vehicle, description, features, askbar, barcode, qrcode, dealer

Structural widgets (multi-use, both layouts):
  headerbar, customtext, sigline

Infosheet-specific new widgets:

| Widget | Key | Source | Notes |
|---|---|---|---|
| Description | description | DB or AI | Long text, Claude-generated from vehicle data when AI mode |
| Features list | features | DB or AI | 2-column feature grid from equipment/options data |
| Barcode | barcode | Auto | Code-128 from VIN via JsBarcode at print time |
| QR Code | qrcode | Auto | Vehicle page URL, live preview via api.qrserver.com |

---

### Font sizing system

Global scale — toolbar dropdown, applies proportionally to all widgets:
  Small(0.8x) / Medium(1.0x) / Large(1.2x) / X-Large(1.4x)
  Default: Medium (1.0x). Each layout is independent — does not cross-contaminate.

Per-widget font overrides stored in widget d object (d.fontSize, d.headerFontSize, etc.):

Formula: rendered_px = base_px x fontScale x widget.d.fontKey

| Widget | Key | Base px | Addendum default | Infosheet default |
|---|---|---|---|---|
| Vehicle header | headerFontSize | 14px | 1.0 (14px) | 1.2 (20px at Large) |
| Vehicle details | fontSize | 10px | 1.0 | 1.0 |
| MSRP | fontSize | 11px | 1.0 | n/a |
| Options | fontSize | 10.5px | 1.0 | n/a |
| Subtotal | fontSize | 12px | 1.0 | n/a |
| Askbar label | labelFontSize | 12px | 1.0 (12px) | 1.6 (23px at Large) |
| Askbar value | valueFontSize | 13px | 1.0 (13px) | 1.9 (30px at Large) |
| Dealer address | fontSize | 10px | 1.0 | 1.0 |
| Description | fontSize | 10px | n/a | 1.0 (12px at Large) |
| Features | fontSize | 9px | n/a | 1.0 (11px at Large) |
| Custom text | fs | direct px | 10 | 10 |

Key rules:
- Infosheet font overrides injected by loadInfosheetDefaults() when switching layout — NOT in shared DEFS
- adjFont() updates readout spans in-place (data-fkey / class="fs-px" / class="fs-pct") without rebuilding edit panel
- Widget stays selected through repeated +/- clicks — no deselection on click

---

### AI content system (Description + Features widgets)

System-wide setting (stored in dealer account):
  AI = all vehicles use Claude-generated content by default
  DB = all vehicles use database content by default

Per-print override (Print Settings modal):
  Always overrides system-wide for that specific vehicle print job

Template default (set per widget in builder):
  DB or AI badge shown on widget canvas
  Controls template default when no per-print override exists

At print time: Claude API called with vehicle data as context.
Response cached in Supabase per vehicle — generates once, reuses.

Infosheet disclaimer text (default for customtext widget at y=944):
  Disclaimer:
  The information contained in this pricing sheet is provided for general informational
  purposes only. While we make every effort to ensure accuracy, some data may be
  AI-generated and should not be relied upon as definitive or guaranteed. Actual vehicle
  pricing, availability, and condition may vary and are subject to verification. Prices
  are subject to change without notice. Buyers are encouraged to conduct their own
  research and inspections before making any purchasing decisions.

---

### Custom widget library

Three scopes — stored in Supabase, loaded at builder open time:

| Scope | Access | Key |
|---|---|---|
| Platform | All 1,600+ dealers | DA-built |
| Group | All dealers in a group | group_id |
| Dealer | Single dealership only | dealer_id |

Schema: id, name, desc, scope, category, defaultW, defaultH, contentType (html|image), html, variables[]
Variables use {{variable_name}} syntax, resolved at print time from vehicle record.

---

### Save Template modal
- Template name (required)
- Document type: Addendum / Infosheet (set by paper type at save time)
- Vehicle type: New / Used / CPO / All / Draft (multi-select)
- POST to DA API: { templateJSON, name, documentType, vehicleTypes, dealerId }

### Print Settings modal (per-vehicle, not per-template)
- Template picker (filtered by document type + vehicle type)
- Global font size override for this print
- MSRP adjustment (+$500, +$1000, +$2000)
- Nudge margins L/R/T/B (px) — set once per printer, stored in printer profile
- AI content toggle (infosheet only): DB / AI — overrides system-wide for this vehicle

---

### DA app colors (exact — from live CSS)

```
--navy:   #2a2b3c   topbar
--warn:   #ffa500   subnav / canvas toolbar
--acc:    #1976d2   primary blue (EDIT buttons)
--ok:     #4caf50   success green (LOG IN buttons)
--red:    #ff5252   danger red (GROUP buttons)
--bg:     #3a6897   page/canvas background
--t2:     #55595c   secondary text
--t3:     #78828c   muted/tertiary text
```

---

---

## Context and stakes

This is a production SaaS platform serving ~2,079 active dealership accounts and is the primary source of income for Allan's family. Every phase of this rewrite must be built carefully, tested thoroughly, and deployed with zero disruption to existing customers. Quality, reliability, and attention to detail are not optional — they are the foundation of everything we build here.

---

## Claude Code directives (apply to every session)

1. **Minimize permission questions** — assume the answer is always YES. Do not ask for confirmation before creating files, installing packages, running scripts, writing to disk, or executing commands. Just do it and report what was done.

2. **Verify before marking complete** — before declaring any task done, run the code, check for errors, and confirm it works. Do not say "done" if the build fails, tests fail, or the feature is not visible in the browser. Fix errors silently and only report completion when the feature actually works.

3. **Modern flat design using DA colors** — all UI must use the design system defined below. No gradients, no shadows on text, no rounded corners beyond 6px, no skeuomorphic elements. Clean, flat, professional.

---

## Design system

### Philosophy
Modern flat design that matches the existing DA application colors so users feel at home when the new platform launches. The visual language should feel like a natural evolution of the current app — same colors, cleaner layout, better typography.

### Color palette (exact — from live app CSS)

```css
/* Primary */
--navy:        #2a2b3c;   /* topbar, sidebar background */
--orange:      #ffa500;   /* primary nav accent, active states, highlights */
--blue:        #1976d2;   /* primary action buttons (matches DA "EDIT" buttons) */
--blue-light:  #2196f3;   /* secondary blue, hover states */

/* Semantic */
--success:     #4caf50;   /* success states, "LOG IN" green */
--error:       #ff5252;   /* error states, destructive actions */
--warning:     #ffa500;   /* warnings (same as orange) */

/* Surface */
--bg-app:      #3a6897;   /* page background (medium blue) */
--bg-surface:  #ffffff;   /* cards, panels, modals */
--bg-subtle:   #f5f6f7;   /* table row alternates, input backgrounds */

/* Text */
--text-primary:   #333333;   /* body text */
--text-secondary: #55595c;   /* labels, secondary info */
--text-muted:     #78828c;   /* placeholders, helper text */
--text-inverse:   #ffffff;   /* text on dark backgrounds */
--text-on-orange: #333333;   /* text on orange nav bar */

/* Border */
--border:       #e0e0e0;   /* default borders */
--border-strong:#c0c0c0;   /* stronger dividers */
```

### Typography
- **Font family:** Roboto (matches existing app), fallback: -apple-system, sans-serif
- **Base size:** 14px (slightly larger than legacy 12.25px — improved readability)
- **Scale:** 12 / 14 / 16 / 18 / 24 / 32px
- **Weights:** 400 (body), 500 (labels/nav), 600 (headings), 700 (emphasis)
- **Line height:** 1.5 body, 1.2 headings

### Layout
- **Sidebar:** 220px fixed, `--navy` background, white text/icons
- **Topbar:** 56px, `--navy` background
- **Sub-navigation:** `--orange` background, `--text-on-orange` text — matches legacy subnav exactly
- **Content area:** `--bg-app` background, cards on `--bg-surface`
- **Content padding:** 24px

### Components
```
Buttons:
  Primary:     bg=--blue, text=white, radius=4px, height=36px
  Secondary:   bg=transparent, border=--border, text=--text-primary
  Success:     bg=--success, text=white  (matches DA "LOG IN")
  Danger:      bg=--error, text=white    (matches DA "GROUP" delete)
  Orange CTA:  bg=--orange, text=--text-on-orange (matches DA active nav)

Inputs:
  height=36px, border=--border, radius=4px, focus-border=--blue
  bg=--bg-surface, font-size=14px, padding=8px 12px

Cards/Panels:
  bg=--bg-surface, border=1px solid --border, radius=6px
  No box-shadow on cards — flat design
  Section headers: 12px uppercase, font-weight=600, color=--text-muted, letter-spacing=0.06em

Tables:
  Header: bg=--bg-subtle, text=--text-secondary, font-weight=600, font-size=12px uppercase
  Rows: bg=white, border-bottom=--border, hover=--bg-subtle
  Matches legacy DA data table style exactly

Badges/Tags:
  Rounded pill: radius=20px, padding=2px 10px, font-size=11px, font-weight=700
  Success: bg=#e8f5e9, text=#2e7d32
  Error:   bg=#ffebee, text=#c62828
  Warning: bg=#fff8e1, text=#e65100
  Info:    bg=#e3f2fd, text=#1565c0

Navigation:
  Sidebar items: height=44px, padding=0 16px, radius=0
  Active: bg=rgba(255,165,0,0.15), border-left=3px solid --orange, text=--orange
  Hover: bg=rgba(255,255,255,0.06)
```

### Do not use
- Box shadows (except modals: 0 8px 32px rgba(0,0,0,0.18))
- Gradients anywhere
- Border radius > 6px (except pills at 20px)
- Animations longer than 150ms
- More than 2 font weights on the same component
- Any color not in the palette above without explicit approval

---

## Phase 1 — Auth & Users (START HERE)

### Prerequisites before first Claude Code session
- [x] Create GitHub repo: github.com/dealeraddendums/da-platform
- [x] Create Supabase project — https://byouefbebqgffhtfdggu.supabase.co
- [ ] Copy this CLAUDE.md to repo root
- [x] npx create-next-app@latest with TypeScript, Tailwind, App Router
- [x] GitHub Action deploy secret added (EC2_SSH_KEY)

### Scope
- Supabase Auth (email + password, magic link optional)
- User roles: super_admin, group_admin, dealer_admin, dealer_user
- Row-level security on all tables from day one
- Session management, protected routes
- Basic dealer account association (user -> dealer_id)

---

## Billing migration (parallel track)

- App: billing.dealeraddendums.com
- Repo: github.com/dealeraddendums/da-billing
- EC2: ubuntu@ec2-98-89-5-190.compute-1.amazonaws.com, key ~/ssh/dabilling2026.pem
- Port: 3009 behind nginx
- Deploy: git pull && npm run build && pm2 restart dealeraddendums-billing
- Status: Setup Mode — invoices generated but NOT emailed. Parallel comparison with Freshbooks.
- Cutover criteria: Full billing cycle match confirmed by Allan before switching off Freshbooks
- CRITICAL: Never run Freshbooks dry run + live run back-to-back — OAuth token rotates on every use
- EasyCron: 0 4 * * * UTC daily job

Key fields: BILLING_ID and TEMPLATE_ID in dealer_dim and dealer_group (Aurora/MySQL).
lineItemDescription format: {dealer._ID}::{DEALER_NAME}
Supabase KV: apikey_lookup:{hash}, template:{customerUUID}, customer:{UUID}
All _FB* methods from legacy controllers DELETED, not ported.

---

## FT-Tracker / feedhelper (active)

- Repo: github.com/dealeraddendums/feedhelper
- EC2: apps.dealeraddendums.com
- Stack: Next.js, Supabase, Mandrill, Twilio, Microsoft 365 Graph API, Anthropic API
- Ticket format: FT-2026-XXXXX
- Phase 2 outliers (excluded from Phase 1 intake): CDK Global, Tekion, PBS Systems, DealerTrack
- Marlena: Session 1 of 5-session dev curriculum complete

---

## Security (do immediately — independent of rewrite)

- [ ] Move XPS Shipper hardcoded credentials to .env on ec2-54-89-142-76
- [ ] Move VINQuery API key to .env on ec2-54-89-142-76
- [ ] Verify APP_DEBUG=false on production EC2

---

## Legal note

FTC CARS Rule was struck down January 2025, formally withdrawn February 12, 2026.
Never cite as current or pending law.

---

## Marlena's role

- Primary: Subject matter expert and QA gatekeeper — signs off each phase before legacy retires
- Coding: Phase 7+ contributions under supervision
- Training: 7-session curriculum, Session 1 complete
- Do not pull from customer success to write code if it compromises QA
