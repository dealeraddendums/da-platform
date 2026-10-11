// Migration plan gate (Allan, 2026-10-11): ONLY paying dealers are migrated.
//
// Free, Trial, Trial Expired and Downgraded dealers — and any dealer with no
// paid plan at all — are never migrated, force-migrated, invited, claimed or
// group-migrated. "Paying" reuses billing's own definition,
// isBillableAccountType() (lib/group-discount.ts), so migration and the group
// discount tiers can't disagree about who is a customer. One exception: a
// group-billed dealer with no plan of its own on the row is paid for by its
// group, so it counts as paying unless its plan EXPLICITLY says Free/Trial.
//
// Enforced server-side at every entry point, with migrateDealerRecord() as the
// last line (it re-reads the plan from the database before writing anything):
//   readiness eligibility (→ claim-next, send-wave, force queue verdict) ·
//   assign/claim group · force-migrate (5.0 plan AND the live 4.0 plan) ·
//   /api/migrate/confirm · first-login migration · group migrate + group
//   self-migrate (member skipped) · every invite/follow-up sender.

import { isBillableAccountType } from "./group-discount";

/** Plans that are never migrated, whoever pays. Lowercased, " $NNN" stripped. */
const EXCLUDED_PLANS: ReadonlySet<string> = new Set(["free", "trial", "trial expired", "downgraded"]);

export const NOT_MIGRATED_LABEL = "Free/Trial — not migrated";

export interface PlanGateDealer {
  account_type: string | null | undefined;
  subscription_billed_to?: string | null;
  group_id?: string | null;
}

const planBase = (at: string | null | undefined) => String(at ?? "").split(" $")[0].trim();

/** null = the dealer's plan may be migrated; otherwise the refusal reason. */
export function migrationPlanBlock(d: PlanGateDealer): string | null {
  const label = planBase(d.account_type);
  const base = label.toLowerCase();
  if (EXCLUDED_PLANS.has(base)) return `${NOT_MIGRATED_LABEL} (plan: ${label})`;
  if (isBillableAccountType(d.account_type)) return null;
  if (d.subscription_billed_to === "group" && d.group_id) return null;
  return `no paid plan — not migrated (plan: ${label || "none"})`;
}

/** Same rule against the live 4.0 ACCOUNT_TYPE (force-migrate reads it from the ETL box). */
export function legacyPlanBlock(accountType: string | null | undefined): string | null {
  const label = planBase(accountType);
  if (EXCLUDED_PLANS.has(label.toLowerCase())) return `${NOT_MIGRATED_LABEL} (4.0 plan: ${label})`;
  return null;
}
