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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:", failures.join(", ")); process.exit(1); }
