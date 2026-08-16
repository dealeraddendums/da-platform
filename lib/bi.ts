// Business Intelligence report builder for the super_admin BI tab.
// Spec: docs/superadmin-bi-tab.md (incl. the Sample SQL appendix + the
// "classification rule" box). One entry point — buildBiReport(from, to).
//
// Classification rule (from the doc): lean on the dedicated TIMESTAMPS —
// converted_at (conversion event), downgraded_at (paid→Free cancel event),
// created_at + TRIAL_DAYS_CAP (trial day-cap expiry). The ONLY safe SQL
// account_type test is the trial one; paid/free buckets go through
// lib/print-eligibility.ts helpers so BI matches the rest of the app.
//
// Period semantics: half-open [from 00:00Z, (to+1d) 00:00Z) — `to` is an
// inclusive end DATE, so the whole day counts and boundaries don't double-count.

import { createAdminSupabaseClient } from "@/lib/db";
import { isTrialAccountType, isPaidAccountType, TRIAL_DAYS_CAP } from "@/lib/print-eligibility";
import { getGrossBillable, billingConfigured } from "@/lib/billing";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BiReport {
  period: { from: string; to: string };
  generatedAt: string;
  /** Point-in-time snapshot (NOT period-filtered) — current active book.
   *  paying = active + isPaidAccountType; trial = active + independent +
   *  isTrialAccountType. Both exclude test accounts. */
  totals: { payingAccounts: number; trialAccounts: number };
  trials: {
    /** Independent dealers created in-period that started as a trial — counts
     *  those that have since converted/downgraded too (matches the doc). */
    started: number;
    /** COHORT conversion rate: cohort.converted / started, %, 1dp — ≤100 by
     *  construction. 0 when started === 0. Provisional while cohort members
     *  are still trialing. (Never activity-over-cohort — the old 180% bug.) */
    conversionRate: number;
    /** Cohort breakdown of the trials STARTED in-period — reconciles exactly:
     *  started === converted + lost + stillActive. Lost honors trial_ends_at
     *  extensions and counts downgraded/self-closed trials. */
    cohort: { started: number; converted: number; lost: number; stillActive: number };
    /** PERIOD ACTIVITY (raw counts, any cohort — never a rate):
     *  trialConversions   = independent NATIVE trials that went paid in-period
     *                       (converted_at in window; is_native excludes 4.0→5.0
     *                       migration cutovers, which also stamp converted_at).
     *  trialConversionsGroup = ss_-born dealers now group-attached that
     *                       converted (anomaly watch; expected 0 — group
     *                       accounts do not start as trials).
     *  migrations         = the remaining converted_at events: 4.0→5.0
     *                       migration go-lives, NOT trial wins.
     *  lost*              = trial windows that closed in-period without
     *                       converting (30-day cap, honoring trial_ends_at
     *                       extensions; expiry clamped to now). */
    activity: {
      trialConversions: number;
      trialConversionsGroup: number;
      migrations: number;
      lost: number;
      lostIndependent: number;
      lostGroup: number;
    };
  };
  acquisition: { source: string; count: number }[];
  groupDealersAdded: number;
  cancellations: {
    independent: number;
    group: number;
    total: number;
    /** Cancellations (downgraded_at in-period) with NO closure row in-period —
     *  the size of the Gap-C "Not specified" hole. */
    withoutReason: number;
    /** Secondary, later-stage signal — archived (active=false) in-period. */
    archivedIndependent: number;
    archivedGroup: number;
    reasons: { reason: string; independent: number; group: number; total: number }[];
  };
  revenue: {
    available: boolean;
    series: { month: string; grossBilled: number }[];
    currentMrr: number;
    error?: string;
  };
}

type DealerLite = {
  id: string;
  dealer_id: string | null;
  group_id: string | null;
  account_type: string | null;
  is_native: boolean | null;
  created_at: string | null;
  converted_at: string | null;
  downgraded_at: string | null;
  inactivated_at: string | null;
  trial_ends_at: string | null;
  acquisition: Record<string, unknown> | null;
};

const DEALER_COLS =
  "id, dealer_id, group_id, account_type, is_native, created_at, converted_at, downgraded_at, inactivated_at, trial_ends_at, acquisition";

/** Paginate a dealers query past PostgREST's 1000-row cap. Every dealer query
 *  excludes test accounts — `is_test IS NOT TRUE` (matches false OR null) — so
 *  no metric counts a test dealer (classification-rule box). */
async function fetchDealers(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  build: (q: unknown) => unknown,
): Promise<DealerLite[]> {
  const out: DealerLite[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = (admin.from("dealers").select(DEALER_COLS) as any).not("is_test", "is", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (build(base) as any).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as DealerLite[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Bucket a dealer's acquisition jsonb into a human label (doc metric 4).
 *  Normalizes obvious duplicates so the table reads as one row per real
 *  channel: gclid ⇒ "Google Ads" (paid); utm_source/referrer variants of the
 *  same engine collapse ("google" + "www.google.com" ⇒ "Google"); a referrer
 *  from our own site is not an acquisition source ⇒ "Direct / Unknown". */
function normalizeSourceName(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^www\./, "");
  if (!s) return "Direct / Unknown";
  if (s.includes("dealeraddendums")) return "Direct / Unknown"; // our own site
  if (s === "google" || s.includes("google.")) return "Google";
  if (s === "bing" || s.includes("bing.")) return "Bing";
  if (s === "duckduckgo" || s.includes("duckduckgo.")) return "DuckDuckGo";
  if (s === "yahoo" || s.includes("yahoo.")) return "Yahoo";
  if (s === "fb" || s === "facebook" || s.includes("facebook.")) return "Facebook";
  if (s.includes("linkedin")) return "LinkedIn";
  // Title-case single-word utm sources; hosts pass through as-is.
  return s.includes(".") ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function acquisitionBucket(acq: Record<string, unknown> | null): string {
  if (!acq || typeof acq !== "object") return "Direct / Unknown";
  const gclid = acq.gclid;
  if (typeof gclid === "string" && gclid.trim()) return "Google Ads";
  const utmSource = acq.utm_source;
  if (typeof utmSource === "string" && utmSource.trim()) return normalizeSourceName(utmSource);
  const referrer = acq.referrer;
  if (typeof referrer === "string" && referrer.trim()) {
    try { return normalizeSourceName(new URL(referrer).host); }
    catch { return normalizeSourceName(referrer); }
  }
  return "Direct / Unknown";
}

/** Trial-window expiry: operator extension (trial_ends_at) wins, else
 *  created_at + 30 days. The datable "lost" axis; the 30-print cap has no
 *  stored event date and is intentionally not used for dating losses. */
function trialExpiryMs(d: DealerLite, nowMs: number): number {
  if (d.trial_ends_at) return new Date(d.trial_ends_at).getTime();
  return (d.created_at ? new Date(d.created_at).getTime() : nowMs) + TRIAL_DAYS_CAP * DAY_MS;
}

/** Started-as-a-trial predicate for dealers CREATED in a window. A live trial
 *  account_type is the direct signal; for dealers that have since moved on,
 *  converted_at/downgraded_at count ONLY on is_native rows — non-native
 *  (Aurora-origin) dealers get converted_at stamped by 4.0→5.0 MIGRATION
 *  flows and were never 5.0 trials. */
function startedAsTrial(d: DealerLite): boolean {
  if (isTrialAccountType(d.account_type)) return true;
  return d.is_native === true && (d.converted_at != null || d.downgraded_at != null);
}

export async function buildBiReport(from: string, to: string): Promise<BiReport> {
  const admin = createAdminSupabaseClient();

  const startIso = new Date(`${from}T00:00:00.000Z`).toISOString();
  const endExclusiveIso = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS).toISOString();
  const startMs = new Date(startIso).getTime();
  const endExclusiveMs = new Date(endExclusiveIso).getTime();
  const nowMs = Date.now();

  // ── A1. Trials started (independent denominator) ─────────────────────────
  // Independent (group_id NULL), created in-period, that STARTED as a trial —
  // including dealers that have since converted (account_type no longer trial)
  // or downgraded. We can't express "is/was a trial" purely in account_type, so
  // fetch independent dealers created in-period and apply the doc's predicate:
  //   isTrialAccountType(now)  OR  converted_at IS NOT NULL  OR  downgraded_at IS NOT NULL
  const independentCreated = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).is("group_id", null).gte("created_at", startIso).lt("created_at", endExclusiveIso),
  );
  const startedRows = independentCreated.filter(startedAsTrial);
  const started = startedRows.length;

  // Cohort breakdown of the started set (reconciles exactly). Day-cap is the
  // datable axis (trial_ends_at extensions honored); print-cap is approximate
  // and intentionally not used here. A downgraded/self-closed trial is LOST,
  // not still-active, regardless of its expiry date.
  let cohortConverted = 0, cohortLost = 0, cohortActive = 0;
  for (const d of startedRows) {
    if (d.converted_at) { cohortConverted++; continue; }
    if (d.downgraded_at) { cohortLost++; continue; }
    if (trialExpiryMs(d, nowMs) <= nowMs) cohortLost++; else cohortActive++;
  }

  // Acquisition breakdown over the started cohort.
  const acqMap = new Map<string, number>();
  for (const d of startedRows) {
    const bucket = acquisitionBucket(d.acquisition);
    acqMap.set(bucket, (acqMap.get(bucket) ?? 0) + 1);
  }
  const acquisition = Array.from(acqMap.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  // ── A2. Conversion EVENTS in-period (converted_at in window), classified ──
  // converted_at is stamped by TWO flows: the trial→paid upgrade AND the
  // 4.0→5.0 migration go-live (lib/migrate-dealer.ts). Counting them together
  // was the page's central lie ("Trials Won 20" when 19 were migrations). The
  // discriminator: only is_native dealers can be 5.0 trials — non-native
  // (Aurora-origin) rows with converted_at are migrations by construction.
  const convertedRows = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).gte("converted_at", startIso).lt("converted_at", endExclusiveIso),
  );
  const trialConversions = convertedRows.filter((d) => d.group_id == null && d.is_native === true).length;
  const trialConversionsGroup = convertedRows.filter(
    (d) => d.group_id != null && (d.dealer_id ?? "").startsWith("ss_"),
  ).length;
  const migrations = convertedRows.length - trialConversions - trialConversionsGroup;

  // The conversion RATE is cohort-based (of the trials STARTED in-period, how
  // many converted) — ≤100% by construction. NEVER activity ÷ cohort.
  const conversionRate = started > 0 ? Math.round((cohortConverted / started) * 1000) / 10 : 0;

  // ── A3. Lost-trial EVENTS in-period: the trial window CLOSED in-window ────
  // (expiry = trial_ends_at override, else created_at + 30d) without ever
  // converting or self-closing, and only if the expiry has actually passed
  // (clamped at now). Fetch candidates by the never-converted/never-closed
  // predicate and date the expiry in memory — trial_ends_at extensions can't
  // be windowed on created_at in SQL.
  const lostCandidates = await fetchDealers(admin, (q) =>
    (q as any) // eslint-disable-line @typescript-eslint/no-explicit-any
      .is("converted_at", null)
      .is("downgraded_at", null),
  );
  const lostRows = lostCandidates.filter((d) => {
    if (!isTrialAccountType(d.account_type)) return false;
    const expiry = trialExpiryMs(d, nowMs);
    return expiry >= startMs && expiry < endExclusiveMs && expiry <= nowMs;
  });
  const lost = lostRows.length;
  const lostIndependent = lostRows.filter((d) => d.group_id == null).length;
  const lostGroup = lost - lostIndependent;

  // ── B1. Group dealer accounts added ──────────────────────────────────────
  const groupDealersAdded = await countDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).not("group_id", "is", null).gte("created_at", startIso).lt("created_at", endExclusiveIso),
  );

  // ── B2. Cancellations (downgraded_at in-period), split ───────────────────
  const cancelledRows = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).gte("downgraded_at", startIso).lt("downgraded_at", endExclusiveIso),
  );
  const cancelIndependent = cancelledRows.filter((d) => d.group_id == null).length;
  const cancelGroup = cancelledRows.length - cancelIndependent;

  // Secondary: archived (active=false) in-period via inactivated_at.
  const archivedRows = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).gte("inactivated_at", startIso).lt("inactivated_at", endExclusiveIso),
  );
  const archivedIndependent = archivedRows.filter((d) => d.group_id == null).length;
  const archivedGroup = archivedRows.length - archivedIndependent;

  // ── B3. Cancellation reasons (account_closures ⋈ dealers, closed_at in-period)
  // !inner join + is_test filter drops closures belonging to test dealers, so
  // the reasons table matches the test-excluded cancellation counts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: closureData, error: closureErr } = await (admin as any)
    .from("account_closures")
    .select("dealer_id, reason, closed_at, dealers!inner(group_id, is_test)")
    .not("dealers.is_test", "is", true)
    .gte("closed_at", startIso)
    .lt("closed_at", endExclusiveIso);
  if (closureErr) throw closureErr;
  const closures = (closureData ?? []) as {
    dealer_id: string; reason: string | null; closed_at: string; dealers: { group_id: string | null } | null;
  }[];

  const reasonAgg = new Map<string, { independent: number; group: number }>();
  const closureDealerIds = new Set<string>();
  for (const c of closures) {
    closureDealerIds.add(c.dealer_id);
    const reason = (c.reason ?? "").trim() || "Not specified";
    const isGroup = c.dealers?.group_id != null;
    const cur = reasonAgg.get(reason) ?? { independent: 0, group: 0 };
    if (isGroup) cur.group++; else cur.independent++;
    reasonAgg.set(reason, cur);
  }
  const reasons = Array.from(reasonAgg.entries())
    .map(([reason, v]) => ({ reason, independent: v.independent, group: v.group, total: v.independent + v.group }))
    .sort((a, b) => b.total - a.total);

  // Reconciliation: cancellations (downgraded_at in-period) with NO closure row.
  const withoutReason = cancelledRows.filter((d) => !closureDealerIds.has(d.id)).length;

  // ── Current totals (point-in-time snapshot of the active book) ───────────
  // Per the classification rule, paid/trial buckets go through the
  // print-eligibility helpers (not raw account_type SQL). Active + test-excluded.
  // Trial is restricted to independent (group_id NULL) — group dealers are
  // provisioned by their group, not trials, and a null account_type on a group
  // dealer must not inflate the trial count.
  const activeRows = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).eq("active", true),
  );
  let payingAccounts = 0, trialAccounts = 0;
  for (const d of activeRows) {
    if (isPaidAccountType(d.account_type)) payingAccounts++;
    else if (d.group_id == null && isTrialAccountType(d.account_type)) trialAccounts++;
  }

  // ── C. Revenue (da-billing) ──────────────────────────────────────────────
  // Pass test dealers' da-billing customer IDs so gross-billable + MRR exclude
  // them too (da-billing has no native test flag — DA Platform is the source of
  // truth for is_test).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: testRows } = await (admin.from("dealers").select("billing_customer_id") as any)
    .eq("is_test", true)
    .not("billing_customer_id", "is", null);
  const excludeCustomerIds = ((testRows ?? []) as { billing_customer_id: string | null }[])
    .map((r) => r.billing_customer_id)
    .filter((x): x is string => Boolean(x));

  // The revenue trend is a FIXED last-12-months window regardless of the date
  // picker — a single-month range rendered a one-point "chart". MRR rides on
  // the same call (it's point-in-time, not range-dependent).
  let revenue: BiReport["revenue"];
  if (!billingConfigured()) {
    revenue = { available: false, series: [], currentMrr: 0, error: "Billing API not configured" };
  } else {
    try {
      const nowD = new Date();
      const fmt = (d: Date) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const seriesFrom = fmt(new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 11, 1)));
      const seriesTo = fmt(nowD);
      const gb = await getGrossBillable(seriesFrom, seriesTo, excludeCustomerIds);
      revenue = { available: true, series: gb.series, currentMrr: gb.currentMrr };
    } catch (err) {
      revenue = { available: false, series: [], currentMrr: 0, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    period: { from, to },
    generatedAt: new Date().toISOString(),
    totals: { payingAccounts, trialAccounts },
    trials: {
      started,
      conversionRate,
      cohort: { started, converted: cohortConverted, lost: cohortLost, stillActive: cohortActive },
      activity: {
        trialConversions,
        trialConversionsGroup,
        migrations,
        lost,
        lostIndependent,
        lostGroup,
      },
    },
    acquisition,
    groupDealersAdded,
    cancellations: {
      independent: cancelIndependent,
      group: cancelGroup,
      total: cancelledRows.length,
      withoutReason,
      archivedIndependent,
      archivedGroup,
      reasons,
    },
    revenue,
  };
}

// ── Period Summary (fixed windows grid) ──────────────────────────────────────
// One fetch of all non-test dealers, all windows computed in memory — the grid
// is 10 windows × 6 event metrics and per-window SQL would be 60+ queries.
// Metric semantics MATCH buildBiReport's classification rule (dedicated
// timestamps; never updated_at, which the daily ETL touches for every dealer).

export interface PeriodSummaryRow {
  label: string;
  newTrials: number;
  /** Independent NATIVE trial → paid conversions (same rule as the funnel's
   *  activity.trialConversions — migrations are NOT trials won). */
  trialsWon: number;
  trialsLost: number;
  /** 4.0→5.0 migration go-lives (converted_at events that are not trial
   *  conversions). Informational — already-paying customers changing
   *  platforms, so deliberately NOT part of newPaying/growth. */
  migrationsLive: number;
  groupAdded: number;
  manualAdded: number;
  downgradedFree: number;
  newPaying: number;
  growthPct: number | null;
}

export interface PeriodSummary {
  periods: PeriodSummaryRow[];
  totalPaying: number;
  generatedAt: string;
}

/** Fixed reporting windows, half-open [from, to). Server clock (UTC on prod). */
function getPeriodWindows(now: Date): { label: string; from: Date; to: Date }[] {
  const year = now.getFullYear();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = now.getDay(); // 0=Sun
  const mondayDiff = now.getDate() - day + (day === 0 ? -6 : 1);
  const thisWeekStart = new Date(now.getFullYear(), now.getMonth(), mondayDiff);
  const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const thisMonthStart = new Date(year, now.getMonth(), 1);
  const lastMonthStart = new Date(year, now.getMonth() - 1, 1);

  return [
    { label: "Today",      from: todayStart,               to: now },
    { label: "This Week",  from: thisWeekStart,            to: now },
    { label: "Last Week",  from: lastWeekStart,            to: thisWeekStart },
    { label: "This Month", from: thisMonthStart,           to: now },
    { label: "Last Month", from: lastMonthStart,           to: thisMonthStart },
    { label: "Q1",         from: new Date(year, 0, 1),     to: new Date(year, 3, 1) },
    { label: "Q2",         from: new Date(year, 3, 1),     to: new Date(year, 6, 1) },
    { label: "Q3",         from: new Date(year, 6, 1),     to: new Date(year, 9, 1) },
    { label: "Q4",         from: new Date(year, 9, 1),     to: new Date(year + 1, 0, 1) },
    { label: "YTD",        from: new Date(year, 0, 1),     to: now },
  ];
}

type PeriodDealer = DealerLite & { dealer_id: string | null; active: boolean | null };

export async function buildPeriodSummary(): Promise<PeriodSummary> {
  const admin = createAdminSupabaseClient();

  // Single paginated fetch, test-excluded (same convention as fetchDealers).
  const rows: PeriodDealer[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin
      .from("dealers")
      .select("id, dealer_id, group_id, account_type, is_native, created_at, converted_at, downgraded_at, trial_ends_at, active") as any)
      .not("is_test", "is", true)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as PeriodDealer[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  // Denominator: current active paying book (same rule as totals.payingAccounts).
  const totalPaying = rows.filter((d) => d.active === true && isPaidAccountType(d.account_type)).length;

  const inWin = (iso: string | null, fromMs: number, toMs: number) => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return t >= fromMs && t < toMs;
  };

  const nowMs = Date.now();
  const periods = getPeriodWindows(new Date()).map(({ label, from, to }) => {
    const fromMs = from.getTime();
    const toMs = to.getTime();

    let newTrials = 0, trialsWon = 0, trialsLost = 0, migrationsLive = 0, groupAdded = 0, manualAdded = 0, downgradedFree = 0;
    for (const d of rows) {
      const createdIn = inWin(d.created_at, fromMs, toMs);
      const independent = d.group_id == null;

      // Started as a trial — SAME predicate as the funnel (startedAsTrial):
      // migration-stamped converted_at on non-native rows must not count.
      if (createdIn && independent && startedAsTrial(d)) newTrials++;

      // Conversion EVENTS, classified with the funnel's discriminator:
      // independent native = trial won; everything else = migration go-live.
      if (inWin(d.converted_at, fromMs, toMs)) {
        if (independent && d.is_native === true) trialsWon++;
        else migrationsLive++;
      }

      // Lost-trial EVENTS: still a trial, never converted/cancelled, and the
      // trial window (trial_ends_at override, else created+30d) closed inside
      // the window. Clamped at now — future expiries could still convert, and
      // without the clamp the quarters wouldn't reconcile with YTD.
      if (isTrialAccountType(d.account_type) && !d.converted_at && !d.downgraded_at && d.created_at) {
        const expiryMs = trialExpiryMs(d, nowMs);
        if (expiryMs >= fromMs && expiryMs < toMs && expiryMs <= nowMs) trialsLost++;
      }

      if (createdIn && !independent) groupAdded++;

      // Manually-added paying: independent, created in window, paid now, not a
      // conversion (converted_at set → already counted in trialsWon), not
      // self-serve. Keeps newPaying's three parts non-overlapping.
      if (createdIn && independent && isPaidAccountType(d.account_type)
        && d.converted_at == null && !(d.dealer_id ?? "").startsWith("ss_")) manualAdded++;

      if (inWin(d.downgraded_at, fromMs, toMs)) downgradedFree++;
    }

    // Migrations are already-paying 4.0 customers changing platforms —
    // deliberately excluded from newPaying and growth.
    const newPaying = trialsWon + groupAdded + manualAdded;
    const growthPct = totalPaying > 0
      ? Math.round(((newPaying - downgradedFree) / totalPaying) * 1000) / 10
      : null;

    return { label, newTrials, trialsWon, trialsLost, migrationsLive, groupAdded, manualAdded, downgradedFree, newPaying, growthPct };
  });

  return { periods, totalPaying, generatedAt: new Date().toISOString() };
}

/** head:true exact count for a filtered dealers query. Excludes test accounts. */
async function countDealers(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  build: (q: unknown) => unknown,
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = (admin.from("dealers").select("id", { count: "exact", head: true }) as any).not("is_test", "is", true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count, error } = await (build(base) as any);
  if (error) throw error;
  return count ?? 0;
}
