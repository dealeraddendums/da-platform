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
    /** Conversion EVENTS in-period (converted_at in window). */
    converted: number;
    convertedIndependent: number;
    /** convertedIndependent / started, %, 1dp. 0 when started === 0. */
    conversionRate: number;
    /** Lost-trial EVENTS in-period (day-cap expiry, never converted/cancelled). */
    lost: number;
    lostIndependent: number;
    lostGroup: number;
    /** Cohort breakdown of the trials STARTED in-period — reconciles exactly:
     *  started === converted + lost + stillActive. */
    cohort: { started: number; converted: number; lost: number; stillActive: number };
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
  group_id: string | null;
  account_type: string | null;
  created_at: string | null;
  converted_at: string | null;
  downgraded_at: string | null;
  inactivated_at: string | null;
  acquisition: Record<string, unknown> | null;
};

const DEALER_COLS =
  "id, group_id, account_type, created_at, converted_at, downgraded_at, inactivated_at, acquisition";

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

/** Bucket a dealer's acquisition jsonb into a human label (doc metric 4). */
function acquisitionBucket(acq: Record<string, unknown> | null): string {
  if (!acq || typeof acq !== "object") return "Direct / Unknown";
  const gclid = acq.gclid;
  if (typeof gclid === "string" && gclid.trim()) return "Google Ads";
  const utmSource = acq.utm_source;
  if (typeof utmSource === "string" && utmSource.trim()) return utmSource.trim().toLowerCase();
  const referrer = acq.referrer;
  if (typeof referrer === "string" && referrer.trim()) {
    try { return new URL(referrer).host || "Direct / Unknown"; }
    catch { return referrer.trim(); }
  }
  return "Direct / Unknown";
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
  const startedRows = independentCreated.filter(
    (d) => isTrialAccountType(d.account_type) || d.converted_at != null || d.downgraded_at != null,
  );
  const started = startedRows.length;

  // Cohort breakdown of the started set (reconciles exactly). Day-cap is the
  // datable axis; print-cap is approximate and intentionally not used here.
  let cohortConverted = 0, cohortLost = 0, cohortActive = 0;
  for (const d of startedRows) {
    if (d.converted_at) { cohortConverted++; continue; }
    const createdMs = d.created_at ? new Date(d.created_at).getTime() : nowMs;
    if (nowMs - createdMs > TRIAL_DAYS_CAP * DAY_MS) cohortLost++; else cohortActive++;
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

  // ── A2. Conversions (event: converted_at in-period) ──────────────────────
  const convertedRows = await fetchDealers(admin, (q) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q as any).gte("converted_at", startIso).lt("converted_at", endExclusiveIso),
  );
  const converted = convertedRows.length;
  const convertedIndependent = convertedRows.filter((d) => d.group_id == null).length;
  const conversionRate = started > 0 ? Math.round((convertedIndependent / started) * 1000) / 10 : 0;

  // ── A3. Lost trials (event: 30-day cap closed in-period, never converted) ─
  // account_type trial (the only safe SQL account_type test) AND converted_at
  // NULL AND downgraded_at NULL AND (created_at + cap) in window. created_at
  // window is therefore [start - cap, end - cap). Split independent vs group.
  const capMs = TRIAL_DAYS_CAP * DAY_MS;
  const lostWindowStartIso = new Date(startMs - capMs).toISOString();
  const lostWindowEndIso = new Date(endExclusiveMs - capMs).toISOString();
  const lostRows = (
    await fetchDealers(admin, (q) =>
      (q as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .is("converted_at", null)
        .is("downgraded_at", null)
        .gte("created_at", lostWindowStartIso)
        .lt("created_at", lostWindowEndIso),
    )
  ).filter((d) => isTrialAccountType(d.account_type));
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

  let revenue: BiReport["revenue"];
  if (!billingConfigured()) {
    revenue = { available: false, series: [], currentMrr: 0, error: "Billing API not configured" };
  } else {
    try {
      const gb = await getGrossBillable(from, to, excludeCustomerIds);
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
      converted,
      convertedIndependent,
      conversionRate,
      lost,
      lostIndependent,
      lostGroup,
      cohort: { started, converted: cohortConverted, lost: cohortLost, stillActive: cohortActive },
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
