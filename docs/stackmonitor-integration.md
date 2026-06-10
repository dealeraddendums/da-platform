# StackMonitor.ai — DA ecosystem monitors + status integration

> For Claude Code + Allan. Created 2026-06-06. Decisions (Allan): public status page
> (`status.dealeraddendums.com`) **+** in-app indicator · dealers see a **curated** view,
> admins see the **full** stack · **live status only** (no history) · StackMonitor has no
> published API yet → a CC pass on the StackMonitor repo exposes a read API we consume.

## Recommended monitors

### 1. HTTP(S) uptime — the front doors (≈1-min interval, expect 200, alert on non-200/timeout/slow)
- **DA Platform** — `app.dealeraddendums.com` (hit a lightweight health route or `/login`). **[dealer-facing: "App / Sign-in"]**
- **da-billing** — `billing.dealeraddendums.com`. **[dealer-facing: "Billing"]**
- **DA Marketing OS** — `www1.dealeraddendums.com` now → `www.dealeraddendums.com` after DNS cutover. [admin]
- **DA API Portal** — `api.dealeraddendums.com`. [admin]
- **Status page itself** — `status.dealeraddendums.com` (so you know the status page is up). [meta]

### 2. Health-endpoint / keyword checks (deeper than "is the port open")
- **da-pdf-service** — `GET /api/health` (returns `api_key`/`aws`/`bucket` booleans). It's on a **private IP** (`172.31.71.67:3001`), so check from **inside the VPC** (agent on the box) or via a DA Platform proxied health route. **[dealer-facing: "Printing"]** — if PDF rendering is down, nobody can print.
- **DA Platform deep-health** (recommended new route, see below) — one check that exercises Supabase + Aurora + S3 + Mandrill + pdf-service and returns per-dependency status.

### 3. Scheduled-job heartbeats (catch silent cron failures — uptime checks miss these)
Each job pings StackMonitor on success; **alert if no ping within the window**:
- **da-billing daily invoice cron** (EasyCron `0 4 * * *` UTC) — silent failure = dealers not invoiced. [admin]
- **DA Legacy ETL daily** (11:00 UTC node-cron, `ec2-34-205-73-152`) — silent failure = stale dealer/group/profile data. [admin]
- **DA Pulse** — vitals (30 min), nightly (02:00), pvr (03:00), **vehicles (04:00)**. The 4am vehicle sync is dealer-relevant (inventory freshness). [vehicles = dealer-facing; rest admin]
- **HubSpot computed sync** (`/api/cron/sync-hubspot-computed`, `0 8 * * *`). [admin]
- **PDF purge cron** (S3). [admin]

### 4. Dependencies / third-party (direct pings, or via the deep-health route)
- **Supabase** — REST + auth health for the primary project `byouefbebqgffhtfdggu` (and marketing `huqohncglbshwuzeguvb`, Pulse `nvzftnzzsgrdqahusqml`). **[dealer-facing: underpins sign-in + all data]**
- **Aurora MySQL** — connectivity / health query (legacy reads + ETL). [admin]
- **S3 `dealer-addendums`** (us-west-1) — HEAD a sentinel object. **[dealer-facing: "PDF storage"]** — dealer sites HEAD `{VIN}.pdf` directly.
- **Mandrill** — API reachability / send health. **[dealer-facing-ish]** — login codes, invites, invoices all ride this.
- **Stripe** — API reachability (payments via da-billing). [admin]
- **HubSpot** — API reachability (Phase-14 sync depends on it). [admin]

### 5. SSL/cert expiry — on every public domain (app, billing, marketing, api, status); alert ~2–3 weeks out. Cheap insurance against a silent cert-expiry outage.

## Curated (dealer) vs full (admin) grouping
- **Dealer-facing status-page components:** **App / Sign-in** (DA Platform + Supabase), **Printing** (da-pdf-service + S3), **Billing** (da-billing). Keep it to what a dealer experiences — don't expose ETL/Pulse/Aurora internals.
- **Admin view:** everything above, including the cron heartbeats, ETL/Pulse, Aurora, HubSpot/Stripe, and per-dependency detail.

## Recommended: a DA Platform "deep-health" endpoint
A single authenticated route (e.g. `GET /api/health/deep`) that probes Supabase, Aurora, S3, Mandrill, and da-pdf-service and returns `{component: ok|degraded|down}` per dependency. StackMonitor hits this one endpoint and the status page reads real per-component signal — cheaper than wiring each dependency as its own external monitor, and it tests the dependency **as the app sees it**.

## Integration plan (after monitors exist)
1. **StackMonitor read API (CC pass on the StackMonitor repo):** expose a small authenticated endpoint that returns each monitor's current state (`up`/`degraded`/`down`) + label/group + a checked-at timestamp. Live status only — no history payload needed.
2. **DA Platform consumer:** a server route (key held server-side) fetches StackMonitor, maps monitors → components, and serves: **public `status.dealeraddendums.com`** (the curated dealer set) + an **in-app indicator** (a status dot/banner; green = all good, amber/red links to the status page). super_admin view shows the **full** set.
3. **Live only:** show current state per component; no uptime-history/incident timeline (Allan's choice).

## Verify
- Each monitor above exists in StackMonitor and reflects a real induced failure (stop pdf-service → "Printing: down").
- Dealer status page shows only the curated components; super_admin sees the full stack.
- In-app indicator flips on a real outage and links to the status page.
- Stop for review before deploy.
