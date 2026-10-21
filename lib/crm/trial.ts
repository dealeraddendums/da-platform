// DA-CRM trial-day math + the daily trial job (POST /api/cron/crm-trial-day,
// 06:00 Pacific). Day 1 = the Pacific calendar day the trial started (same
// as public.crm_trial_day()). A trial ends after 30 days unless the platform
// carries an extended dealers.trial_ends_at (migration 126). The job writes a
// status_change activity when a trial reaches day 7, 14, 21 and expiry —
// once each (external_id 'trial:{company}:{start date}:{milestone}'), and only
// within MILESTONE_GRACE_DAYS of the day itself.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";

export const TRIAL_LENGTH_DAYS = 30;
export const MILESTONES = [7, 14, 21] as const;
export const EXPIRING_WINDOW_DAYS = 7;
const TZ = "America/Los_Angeles";

/** Pacific calendar date (YYYY-MM-DD) of an instant. */
export function pacificDate(d: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(d));
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type TrialStatus = {
  trialDay: number;          // 1-based
  endsOn: string;            // last trial day (Pacific date)
  daysLeft: number;          // 0 on the last day, negative once expired
  flag: "expiring" | "expired" | null;
  milestone: 7 | 14 | 21 | "expired" | null;  // the newest milestone reached
};

export function trialStatus(startedAt: string, now: Date = new Date(), extendedEndsAt: string | null = null): TrialStatus {
  const start = pacificDate(startedAt);
  const today = pacificDate(now);
  const trialDay = dayDiff(today, start) + 1;
  const defaultEnd = addDays(start, TRIAL_LENGTH_DAYS - 1);
  const extEnd = extendedEndsAt ? pacificDate(extendedEndsAt) : null;
  const endsOn = extEnd && extEnd > defaultEnd ? extEnd : defaultEnd;
  const daysLeft = dayDiff(endsOn, today);
  const flag = daysLeft < 0 ? "expired" : daysLeft < EXPIRING_WINDOW_DAYS ? "expiring" : null;
  const milestone = daysLeft < 0 ? "expired" : ([...MILESTONES].reverse().find((m) => trialDay >= m) ?? null);
  return { trialDay, endsOn, daysLeft, flag, milestone };
}

export function milestoneSubject(m: 7 | 14 | 21 | "expired", s: TrialStatus): string {
  return m === "expired"
    ? `Trial expired (ended ${s.endsOn})`
    : `Trial reached day ${m} — ${s.daysLeft + 1} day${s.daysLeft === 0 ? "" : "s"} left`;
}

export const MILESTONE_GRACE_DAYS = 3;

/**
 * Milestones whose day fell within the last MILESTONE_GRACE_DAYS (so a missed
 * run still records them, but back-filled years-old trials don't flood the
 * timeline with day-7/14/21 notes on the first run).
 */
export function dueMilestones(startedAt: string, s: TrialStatus, now: Date = new Date()): (7 | 14 | 21 | "expired")[] {
  const start = pacificDate(startedAt);
  const today = pacificDate(now);
  const recent = (day: string) => { const ago = dayDiff(today, day); return ago >= 0 && ago <= MILESTONE_GRACE_DAYS; };
  const out: (7 | 14 | 21 | "expired")[] = MILESTONES.filter((m) => recent(addDays(start, m - 1)));
  if (s.flag === "expired" && recent(addDays(s.endsOn, 1))) out.push("expired");
  return out;
}

/** The daily job. Idempotent: re-running the same day writes nothing new. */
export async function runTrialDayJob(admin: any = createAdminSupabaseClient(), now = new Date()) {
  const { data: rows, error } = await admin.from("crm_companies")
    .select("id, trial_started_at, trial_day, trial_flag, trial_ends_on, dealer:dealers(trial_ends_at)")
    .eq("kind", "dealer").eq("pipeline_stage", "trial").not("trial_started_at", "is", null);
  if (error) throw new Error(`crm_companies: ${error.message}`);
  const counts = { trials: 0, updated: 0, milestones: 0 };

  for (const c of rows ?? []) {
    counts.trials++;
    const s = trialStatus(c.trial_started_at, now, c.dealer?.trial_ends_at ?? null);
    if (c.trial_day !== s.trialDay || c.trial_flag !== s.flag || c.trial_ends_on !== s.endsOn) {
      await admin.from("crm_companies").update({ trial_day: s.trialDay, trial_flag: s.flag, trial_ends_on: s.endsOn }).eq("id", c.id);
      counts.updated++;
    }
    for (const m of dueMilestones(c.trial_started_at, s, now)) {
      const { error: insErr } = await admin.from("crm_activities").insert({
        company_id: c.id,
        type: "status_change",
        direction: "internal",
        subject: milestoneSubject(m, s),
        metadata: { kind: "trial_milestone", milestone: m, trial_day: s.trialDay, ends_on: s.endsOn },
        external_id: `trial:${c.id}:${pacificDate(c.trial_started_at)}:${m}`,
        occurred_at: now.toISOString(),
      });
      if (!insErr) counts.milestones++;
      else if (insErr.code !== "23505") console.error(`[crm-trial] ${c.id} ${m}:`, insErr.message);
    }
  }
  return counts;
}
