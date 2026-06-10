# DA Business Intelligence tab (SuperAdmin)

> For Claude Code. Owner: Allan. Created 2026-06-08. A super_admin-only analytics tab in DA
> Platform. Default window = **previous calendar month**, custom date range, **PDF + Excel**
> download, **on-demand email**. Most metrics are queries over existing columns; two need a small
> new piece (flagged ⚠️).

## Access & shell
- **super_admin only.** Gate server + UI (mirror the dealer-detail page's role check); the nav
  entry shows only for super_admin. Route e.g. `/admin/bi` (or a tab in the existing admin area).
- **Date range:** default = **previous calendar month** (today Jun 8 → May 1–31). A range picker
  sets custom `from`/`to`. Each metric filters on its own relevant timestamp (below).
- **Design system:** navy topbar / orange active / blue buttons / white cards, no shadow / Roboto /
  established badge palette. Use the app's existing chart approach for the trend line.

## Metrics → sources (Allan's list, regrouped into funnels)

### A. Acquisition & trial funnel (independent / self-serve)
1. **Trials started** — `dealers` where `isTrialAccountType` (account_type `Trial` or NULL) AND
   `group_id IS NULL`, `created_at` in period. (`lib/print-eligibility.ts` defines trial/paid.)
2. **Trials converted to paying** — became paid (`isPaidAccountType`), dated by **`converted_at`**
   (⚠️ new column — see Gaps). Show **conversion rate** = converted ÷ started (cohort note below).
3. **Lost trials (didn't convert)** — trials that crossed the allowance (created_at + 30 days **or**
   30 lifetime prints, `isOverAllowance`) **in period** and never converted (still Trial/NULL, no
   `converted_at`). Day-cap expiry is datable (created_at+30d); print-cap noted as approximate.
4. **How trials found us** — `dealers.acquisition` jsonb (migration 087: utm/gclid/referrer/
   landing) for trials started in period, bucketed: `gclid` present → **Google Ads**; `utm_source`
   value (e.g. google/referral/email); else referrer host; null → **Direct / Unknown**. *Only
   populated for self-serve signups post-087; admin/migrated trials = Direct/Unknown.*

### B. Accounts added & paid churn
5. **Group dealer accounts added** — `dealers` where `group_id IS NOT NULL`, `created_at` in period.
6. **Cancellations (converted → then cancelled)** — previously-paid dealers with **`downgraded_at`
   in period** (downgrade to Free = the cancel moment, per migration 083). **Split: Independent
   (`group_id IS NULL`) vs Group (`group_id IS NOT NULL`)** — that's Allan's "independent dealers
   lost" + "group dealers lost." (Optional secondary number: 60-day **archived** via
   `inactivated_at` — a later stage, shown separately, not the headline.)
7. **Downgrade / cancellation reasons** — join **`account_closures`** (migration 085:
   `reason`/`detail`/`closed_at`) to those dealers, grouped, split independent vs group. *Caveat:
   only the dealer self-close flow writes a closure row; admin-initiated downgrades may have none →
   bucket "Not specified." Recommend also writing a closure row on admin downgrade (Gap C).*

### C. Revenue
8. **Gross billable trend** — monthly series from **da-billing** (⚠️ new endpoint — Gap B): summed
   **invoiced totals per month** (post-discount, what we actually billed) across the range, plus
   the **current MRR run-rate**. Render as a line/bar trend.

> Note on the trial funnel: **group-member dealers are provisioned by their group, not "trials,"**
> so the trial funnel (1–4) is effectively the independent/self-serve story; cancellations (6–7)
> cover both. Keep the group/independent split everywhere so it's unambiguous.

## ⚠️ Two new pieces (everything else is a query)
**A. `dealers.converted_at timestamptz` (migration 095 — confirm current max; 094 is etl_config_lock).**
Set it the moment a trial becomes paid — in `app/api/billing/me/subscription/route.ts` (the
`isConversion` path) and in `app/api/dealers/[id]/route.ts` when `account_type` moves Trial→paid;
clear on re-downgrade if you want re-conversion to re-stamp. **Backfill (best-effort history):** for
existing paid dealers, set `converted_at` from their da-billing customer `createdAt` (for self-serve
conversions the customer is created at conversion, so it's a good proxy; migrated dealers were never
trials, so leave/ignore — they're not in the trial funnel). Going forward it's exact.

**B. da-billing `GET /reports/gross-billable?from=&to=`** → `{ series: [{ month, grossBilled }], currentMrr }`,
computed from invoice totals by month (da-billing already serves the Reports view's data from
`GET /reports` — extend or add alongside). Add a `lib/billing.ts` client `getGrossBillable(from,to)`.

**C. (REQUIRED — confirmed in prod 2026-06-08) Stamp churn on EVERY downgrade path.** A prod check
found **2,107 dealers, 325 with `account_type='free'`, but 0 with `downgraded_at` set and 0
`account_closures` rows.** So the cancellation metric (keys on `downgraded_at`) and the reasons
metric (`account_closures`) have **no data feed today** — only the dealer self-close flow stamps
them, and it hasn't fired. **Every** path that moves a dealer to Free — the **admin** dealers-PATCH
(`account_type`→Free) and any **bulk** path — must set `downgraded_at = now()` AND write an
`account_closures` row (`reason`, `closed_by`). Without this, BI churn reads ~0 forever.
The **325 existing Free accounts are a legacy baseline** (migration-set / never-paid), not
attributable monthly cancellations — leave their `downgraded_at` NULL and measure churn **forward**
from when stamping is in place; pre-stamp cancellations aren't recoverable as dated events — but
the blind spot is small: of the 325, only **36 ever had a `billing_customer_id`** (27 independent /
9 group); the other 289 are legacy never-paid, so forward-measurement loses ≤36 undated events. (Same
shape as the `converted_at` gap: the timestamps only become trustworthy once every write path sets
them.)

## API (da-platform, super_admin-gated)
- `GET /api/admin/bi?from=&to=` → the full report JSON (all metrics). Runs the Supabase queries +
  calls da-billing `getGrossBillable`.
- `GET /api/admin/bi/export?format=pdf|xlsx&from=&to=` → the file. **PDF** via the existing
  **da-pdf-service** (render an HTML report → PDF). **Excel** via a server-side xlsx writer
  (SheetJS/exceljs) — one sheet of summary + a sheet per detail table (acquisition sources,
  cancellation reasons, monthly gross-billable).
- `POST /api/admin/bi/email` `{ from, to, recipients? }` → generates PDF + Excel and emails via
  **Mandrill**, both attached. Default recipient = the acting super_admin's email (prefill
  allan@dealeraddendums.com); allow editing the to-field. **On-demand only** (no cron).

## UI
- Header: date-range picker (default last calendar month) + Apply; buttons **Download PDF**,
  **Download Excel**, **Email report** (recipient field).
- Cards/sections: Trials started · Converted (+rate) · Lost trials; Group dealers added;
  Cancellations — Independent vs Group (with the reasons table); Acquisition-source breakdown;
  Gross-billable trend (line chart) + current MRR.

## Definitions (put these on the page as small print so numbers are unambiguous)
Trial = account_type Trial/NULL; Independent = group_id NULL. Converted = became paid (dated by
converted_at). Lost trial = past 30-day/30-print allowance without converting. Cancellation =
previously-paid dealer with downgraded_at in period. Acquisition source present only for self-serve
signups post-087 (else Direct/Unknown). Reasons present only where an account_closures row exists.
Gross billable = invoiced totals/month (post-discount) from da-billing. Period = previous calendar
month by default.

## Verify
- Spot-check against known truth: trials-started vs HubSpot Dealer-Trial creates; gross-billable vs
  da-billing's MRR card; a known self-close appears with its reason; conversion count matches a
  hand list for a recent month.
- super_admin-only: a group_admin/dealer_admin gets 403 and sees no nav entry.
- PDF + Excel both render and reconcile to the on-screen numbers; email delivers with both attached.
- Conversion rate + lost-trials reconcile: started = converted + lost + still-active-trial.
- STOP for review before deploy.

## Sample SQL (the trickier metrics)
Postgres / Supabase. Period is **half-open `[:from, :to)`** to avoid boundary double-counting.
Default previous calendar month: `:from := date_trunc('month', now()) - interval '1 month'`,
`:to := date_trunc('month', now())`.

> `:from`/`:to` are **bind-parameter placeholders** for the API's parameterized queries (how CC
> wires them). To run a query **by hand in the Supabase SQL editor**, the `:name` syntax errors —
> wrap the period in a CTE and cross-join instead:
> ```sql
> WITH params AS (
>   SELECT date_trunc('month', now()) - interval '1 month' AS from_ts,  -- last calendar month
>          date_trunc('month', now())                      AS to_ts
>   -- custom range: SELECT timestamptz '2026-05-01' AS from_ts, timestamptz '2026-06-01' AS to_ts
> )
> SELECT ... FROM dealers, params WHERE created_at >= params.from_ts AND created_at < params.to_ts;
> ```
> Also: `converted_at` does not exist until **migration 095** is applied — the conversions and
> lost-trials queries error until then. For a pre-095 manual test, drop the `converted_at IS NULL`
> line (the `account_type` trial filter already excludes converted dealers, since their type is no
> longer trial/NULL).

> **Classification rule — read this first.** Lean on the dedicated **timestamps** —
> `converted_at` (conversion event), `downgraded_at` (paid→Free cancel event, set per migration
> 083 only when a *paying* account is downgraded), and `created_at + 30d` (trial day-cap expiry).
> They're unambiguous. Do **NOT** re-implement paid/free classification in SQL — `account_type` is
> free-text, normalized in `lib/print-eligibility.ts` (strips `$price`, many forms; `"Standard"`/
> legacy strings are **not** paid). The only safe SQL `account_type` test is the trial one
> (`IS NULL OR = 'trial'`). Where you need paid/trial/free buckets, fetch rows and use
> `isPaidAccountType`/`isTrialAccountType`/`isFreeAccountType`. Parameterize the caps (=30); don't
> hardcode. Confirm `acquisition` jsonb key names against a real row. **Exclude test accounts —
every platform-side query filters `is_test IS NOT TRUE`** (and da-billing gross-billable should
exclude any test customers) so QA/test dealers never pollute the metrics.

```sql
-- Trials converted (event dated by converted_at; presence of converted_at = a conversion)
SELECT count(*)                                  AS conversions,
       count(*) FILTER (WHERE group_id IS NULL)  AS conversions_independent
FROM dealers
WHERE converted_at >= :from AND converted_at < :to;
```

```sql
-- LOST TRIALS — 30-day window closed in-period without converting.
-- converted_at NULL = never converted; downgraded_at NULL = never a paid cancel (true lost trial).
SELECT count(*)                                     AS lost_trials,
       count(*) FILTER (WHERE group_id IS NULL)     AS lost_trials_independent,
       count(*) FILTER (WHERE group_id IS NOT NULL) AS lost_trials_group
FROM dealers
WHERE (account_type IS NULL OR lower(btrim(split_part(account_type, '$', 1))) = 'trial')
  AND converted_at IS NULL
  AND downgraded_at IS NULL
  AND (created_at + interval '30 days') >= :from
  AND (created_at + interval '30 days') <  :to;
-- Dates loss by the 30-DAY cap. Trials that blew the 30-PRINT cap earlier are still counted here
-- at day-30; to date them at the 30th print you'd need print_history (heavier) — note, don't block.
```

```sql
-- CANCELLATIONS (converted → then cancelled), split independent vs group.
-- downgraded_at IS the "was paying, moved to Free" signal — no account_type reclassification.
SELECT count(*)                                     AS cancellations,
       count(*) FILTER (WHERE group_id IS NULL)     AS cancellations_independent,
       count(*) FILTER (WHERE group_id IS NOT NULL) AS cancellations_group
FROM dealers
WHERE downgraded_at >= :from AND downgraded_at < :to;
```

```sql
-- CANCELLATION REASONS, split independent vs group (account_closures + dealers).
SELECT coalesce(nullif(btrim(ac.reason), ''), 'Not specified')            AS reason,
       CASE WHEN d.group_id IS NULL THEN 'independent' ELSE 'group' END    AS segment,
       count(*)                                                           AS n
FROM account_closures ac
JOIN dealers d ON d.id = ac.dealer_id
WHERE ac.closed_at >= :from AND ac.closed_at < :to
GROUP BY 1, 2
ORDER BY n DESC;
```

```sql
-- Reconciliation: cancellations with NO closure row (→ would show "Not specified").
-- Surface this count; it's the size of the Gap-C admin-downgrade hole.
SELECT count(*) AS cancellations_without_reason
FROM dealers d
WHERE d.downgraded_at >= :from AND d.downgraded_at < :to
  AND NOT EXISTS (SELECT 1 FROM account_closures ac
                  WHERE ac.dealer_id = d.id AND ac.closed_at >= :from AND ac.closed_at < :to);
```

```sql
-- HOW TRIALS FOUND US — acquisition jsonb, trials started in-period.
SELECT CASE
         WHEN nullif(acquisition->>'gclid','')  IS NOT NULL THEN 'Google Ads'
         WHEN nullif(acquisition->>'utm_source','') IS NOT NULL THEN lower(acquisition->>'utm_source')
         WHEN nullif(acquisition->>'referrer','')   IS NOT NULL
              THEN split_part(regexp_replace(acquisition->>'referrer','^https?://(www\.)?',''),'/',1)
         ELSE 'Direct / Unknown'
       END                                          AS source,
       count(*)                                     AS trials
FROM dealers
WHERE group_id IS NULL
  AND (account_type IS NULL OR lower(btrim(split_part(account_type,'$',1))) = 'trial'
       OR converted_at IS NOT NULL)   -- include trials that have since converted
  AND created_at >= :from AND created_at < :to
GROUP BY 1 ORDER BY trials DESC;
```

```sql
-- Trials started (independent) + Group dealers added — the simple denominators.
SELECT count(*) AS trials_started
FROM dealers
WHERE group_id IS NULL
  AND (account_type IS NULL OR lower(btrim(split_part(account_type,'$',1))) = 'trial'
       OR converted_at IS NOT NULL OR downgraded_at IS NOT NULL)
  AND created_at >= :from AND created_at < :to;

SELECT count(*) AS group_dealers_added
FROM dealers
WHERE group_id IS NOT NULL AND created_at >= :from AND created_at < :to;
```
