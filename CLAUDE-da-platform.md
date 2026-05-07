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
**Deploy:** `git pull && npm ci && npm run build && pm2 restart da-platform`
**Logs:** `/var/log/da-platform/`

## Stack

- Next.js 14 (App Router)
- Supabase (auth + all app data)
- Aurora MySQL (READ ONLY — legacy inventory only, being phased out)
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
Dashboard → Options → Builder → Users → My Profile → Settings → [divider] → Order Supplies

**Super admin:**
Dashboard → Dealers → Groups → Users → My Profile → [FEEDS] FTP Server / ETL Server → [ADMIN] Reports / Billing / API Docs / Decoder / Documents / Buyer's Guide PDFs

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

## Critical Rules (in addition to master CLAUDE.md)

### Aurora is Dead — Zero Queries
- All production routes use Supabase only
- `lib/aurora.ts` exists as dead code — do not import it in new code
- The only remaining Aurora reads are in the DA Legacy ETL (separate repo)
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

## Migration Status

Current highest migration: **047**
Always check before creating a new migration to avoid conflicts.
Migration files: `supabase/migrations/`

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

## Key S3 Buckets

| Bucket | Region | Purpose |
|---|---|---|
| `dealer-addendums` | us-west-1 | Generated PDFs (signed 24hr URLs) |
| `addendum-product-images` | us-east-1 | Option/product images |
| `new-dealer-logos` | us-east-1 | Dealer logos |
| `new-infobox-images` | us-east-1 | Infobox PNGs |
| `new-infosheet-backgrounds` | us-east-1 | Infosheet frame PNGs (2657×3438px) |
| `new-addendum-backgrounds` | us-east-1 | Addendum frame PNGs |
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
| Addendum Standard | 4.25"×11" | 638×1650px | 408×1056px |
| Addendum Narrow | 3.125"×11" | 469×1650px | 300×1056px |
| Infosheet | 8.5"×11" | 2657×3438px | 816×1056px |

## Outstanding Issues

- **Bug:** Addendum page not reading `?type=infosheet` / `?type=buyer_guide` param from Bulk buttons
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
RP_ID=app.dealeraddendums.com
RP_NAME=DealerAddendums
RP_ORIGIN=https://app.dealeraddendums.com
```
