/**
 * Checks for the force-migration verdict gate.
 *   npm run test:force-migration
 *
 * This gate is the whole safety story of the feature: it decides whether the
 * Force button renders, AND the force endpoint re-runs it at click time. The
 * cases worth asserting are the ones where a wrong answer hurts a real dealer:
 *   * a dealer who never got the final notice must never be forceable
 *   * a bounced/unconfirmed email must block (a forced dealer with a dead
 *     address is locked out of BOTH platforms)
 *   * a missing legacy DEALER_ID must block (the 4.0 call would 404)
 *   * excluded/held must outrank setup problems, so operators aren't sent off
 *     to "fix billing" on a dealer that must never be individually forced
 */

import { computeForceVerdict, type ForceCandidate } from "../lib/force-migration";
import { decideForceBilling, type ForceBillingInput, type LegacyBillingStatus } from "../lib/force-billing-preflight";
import { migrationPlanBlock, legacyPlanBlock } from "../lib/migration-plan-gate";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

/** A dealer who SHOULD be forceable. Each test bends one thing. */
const good: ForceCandidate = {
  synced: true,
  billingStaged: true,
  billingApplicable: true,
  templateConfirmed: true,
  eligible: true,
  eligibleReason: "eligible",
  finalNoticeAt: "2026-09-25T10:00:00Z",
  hold: false,
  deliverability: "ok",
  legacyDealerId: "MP12345",
  hasRecipient: true,
};
const v = (o: Partial<ForceCandidate>) => computeForceVerdict({ ...good, ...o });

console.log("\nforce-migration — verdict gate\n");

// ── The happy path ─────────────────────────────────────────────────────────
check("fully ready + reachable → safe", v({}).verdict === "safe", v({}).verdict);
check("safe carries no reasons", v({}).reasons.length === 0);

// ── Never force someone who wasn't told ────────────────────────────────────
check("no final notice → not-ready", v({ finalNoticeAt: null }).verdict === "not-ready");
check("no final notice says why", /final notice/i.test(v({ finalNoticeAt: null }).reasons[0] ?? ""));

// ── Never force someone we can't reach ─────────────────────────────────────
check("bounced email → unreachable", v({ deliverability: "bounced" }).verdict === "unreachable");
check("unconfirmed email → unreachable (fail closed)", v({ deliverability: "unknown" }).verdict === "unreachable");
check("no recipient at all → unreachable", v({ hasRecipient: false }).verdict === "unreachable");

// ── Never force someone 4.0 can't be told about ────────────────────────────
check("missing legacy DEALER_ID → not-ready", v({ legacyDealerId: null }).verdict === "not-ready");
check("blank legacy DEALER_ID → not-ready", v({ legacyDealerId: "   " }).verdict === "not-ready");

// ── Setup gates ────────────────────────────────────────────────────────────
check("not synced → not-ready", v({ synced: false }).verdict === "not-ready");
check("template unconfirmed → not-ready", v({ templateConfirmed: false }).verdict === "not-ready");
check("billing unverified → not-ready", v({ billingStaged: false }).verdict === "not-ready");
check(
  "billing N/A (trial/native) does NOT block",
  v({ billingStaged: false, billingApplicable: false }).verdict === "safe",
  v({ billingStaged: false, billingApplicable: false }).verdict,
);
check(
  "multiple setup gaps are all reported",
  v({ synced: false, templateConfirmed: false }).reasons.length === 2,
);

// ── Precedence: "should we force at all" beats "is the setup right" ────────
{
  const excluded = v({ eligible: false, eligibleReason: "white-glove group (Dealer General)", synced: false, deliverability: "bounced" });
  check("ineligible → excluded even with other problems", excluded.verdict === "excluded", excluded.verdict);
  check("excluded surfaces the eligibility reason", excluded.reasons[0] === "white-glove group (Dealer General)");

  const held = v({ hold: true, synced: false });
  check("hold → held even with other problems", held.verdict === "held", held.verdict);

  // A held dealer that is ALSO ineligible reads as excluded: the permanent
  // reason is more useful to the operator than the temporary one.
  const both = v({ hold: true, eligible: false, eligibleReason: "already migrated" });
  check("excluded outranks held", both.verdict === "excluded", both.verdict);
}

// ── Deliverability is checked LAST, so setup problems surface first ────────
{
  const d = v({ synced: false, deliverability: "bounced" });
  check("setup problems reported before email problems", d.verdict === "not-ready", d.verdict);
}


// ── Billing pre-flight + plan gate (2026-10-11): only paying dealers migrate ─
{
  const L = (account_type: string, fb: string, extra: Partial<LegacyBillingStatus> = {}): LegacyBillingStatus =>
    ({ ok: true, found: true, legacy_id: 1, account_type, active: "Yes", recurring: { status: fb, profile_id: fb === "none" ? null : "1" }, ...extra });
  const base: ForceBillingInput = { legacy: L("Automatic Web", "ok"), billedTo: "dealer", payerCustomerId: "cust", template: { active: false } };
  const d = (o: Partial<ForceBillingInput>) => decideForceBilling({ ...base, ...o });

  // Lax Automotive exactly: Free in 4.0, no RECURE_ID, customer but no template.
  const lax = d({ legacy: L("Free", "none"), template: null });
  check("Lax: 4.0 Free → block, Free/Trial not migrated", lax.mode === "block" && /Free\/Trial — not migrated/.test(lax.reason), lax.reason);
  check("4.0 Free with no customer at all → block", d({ legacy: L("Free", "none"), payerCustomerId: null, template: null }).mode === "block");
  check("4.0 Free, group-billed, group template live → still block", d({ legacy: L("Free", "none"), billedTo: "group", template: { active: true } }).mode === "block");
  check("4.0 Free but OWN da-billing template live → block (names the conflict)", /LIVE/.test(d({ legacy: L("Free", "none"), template: { active: true } }).reason));

  // Cancelled: paid label in 4.0 but FreshBooks gone and nothing staged → not paying → block.
  check("paid label + FB deleted + no template → block (cancelled)", d({ legacy: L("Automatic Web $135", "deleted"), template: null }).mode === "block");
  check("paid label + no customer + no FreshBooks → block (cancelled)", d({ legacy: L("Automatic Web", "none"), payerCustomerId: null, template: undefined }).mode === "block");

  // Paying but not staged → block, never migrate.
  const unstaged = d({ legacy: L("Automatic Web", "ok"), template: null });
  check("paying in FreshBooks + no template → block 'billing not staged'", unstaged.mode === "block" && /billing not staged/.test(unstaged.reason), unstaged.reason);
  check("paused FreshBooks + no template → block (ask, don't guess)", d({ legacy: L("Automatic Web", "disabled"), template: null }).mode === "block");
  check("paying + no customer → block", d({ legacy: L("Automatic Web", "ok"), payerCustomerId: null, template: null }).mode === "block");
  check("group-billed paying + group has no template → block", d({ billedTo: "group", template: null }).mode === "block");

  // Normal paid path unchanged.
  check("paying + staged (paused) template → paid", d({}).mode === "paid");
  check("paying + live template → paid", d({ template: { active: true } }).mode === "paid");
  check("FB paused by our cutover + template live → paid (not mistaken for cancelled)", d({ legacy: L("Automatic Web", "disabled"), template: { active: true } }).mode === "paid");
  check("group-billed paying + group template staged → paid", d({ billedTo: "group", template: { active: false } }).mode === "paid");

  // Can't tell → block, nothing changed.
  check("ETL unreachable → block", d({ legacy: null }).mode === "block");
  check("ETL error → block", d({ legacy: { ok: false, error: "HTTP 500" } }).mode === "block");
  check("not in 4.0 → block", d({ legacy: { ok: true, found: false } }).mode === "block");
  check("duplicate DEALER_ID in 4.0 → block", d({ legacy: { ok: true, found: true, ambiguous: true } }).mode === "block");
  check("template unreadable → block", d({ template: undefined }).mode === "block");
  check("FreshBooks status unknown + no template → block", d({ legacy: L("Automatic Web", "unknown"), template: null }).mode === "block");
  check("4.0 Trial → block", d({ legacy: L("Trial", "none"), template: null }).mode === "block");
}

// ── migrationPlanBlock: the one rule every entry point uses ────────────────
{
  const g = (account_type: string | null, billed: string | null = "dealer", group_id: string | null = null) => migrationPlanBlock({ account_type, subscription_billed_to: billed, group_id });
  for (const at of ["Free", "Trial", "Trial Expired", "Downgraded", "free", "Trial $0", "Free $135"]) check(`plan "${at}" → not migrated`, /Free\/Trial — not migrated/.test(g(at) ?? ""), String(g(at)));
  for (const at of ["Manual", "Automatic Web", "Automatic DMS", "Automatic Web $135", "sub-auto-web"]) check(`plan "${at}" (self-billed) → migratable`, g(at) === null, String(g(at)));
  check("blank plan, self-billed → not migrated (no paid plan)", /no paid plan/.test(g(null) ?? ""));
  check("'Standard' (DB default), self-billed → not migrated", /no paid plan/.test(g("Standard") ?? ""));
  check("blank plan, group-billed under a group → migratable (group pays)", g(null, "group", "g1") === null);
  check("group-billed but plan says Free → still not migrated", g("Free", "group", "g1") !== null);
  check("group-billed with no group id → not migrated", g(null, "group", null) !== null);
  check("legacy 4.0 Free → blocked", legacyPlanBlock("Free") !== null);
  check("legacy 4.0 Automatic Web → not blocked by the plan gate", legacyPlanBlock("Automatic Web") === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:", failures.join(", ")); process.exit(1); }
