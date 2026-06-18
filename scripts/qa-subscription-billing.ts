// QA for the subscription→da-billing template planners (pure, no IO).
// Run: npx tsx scripts/qa-subscription-billing.ts
//
// Exercises the risky template-mutation logic deterministically: group tier
// swap, group cancel (non-last + last-sub block), dealer-own merge, and the
// dms-setup add/preserve rules. Exits non-zero on any failure.

import {
  planDealerMerge,
  planGroupTierChange,
  planGroupCancel,
} from "@/lib/billing-subscription";
import { subscriptionDescriptorFor, type BillingProduct } from "@/lib/billing";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failures++; console.log(`  ✗ ${name}`); if (detail !== undefined) console.log("      ", JSON.stringify(detail)); }
}
const ids = (ps: BillingProduct[]) => ps.map((p) => `${p.productId}|${p.lineItemDescription ?? ""}`).sort();
const has = (ps: BillingProduct[], productId: string, ldesc: string) =>
  ps.some((p) => p.productId === productId && p.lineItemDescription === ldesc);

const A = "111", B = "222"; // internal_ids
const dms = subscriptionDescriptorFor("Automatic DMS")!;
const web = subscriptionDescriptorFor("Automatic Web")!;
const man = subscriptionDescriptorFor("Manual")!;

// ── Group tier change ───────────────────────────────────────────────────────
console.log("planGroupTierChange:");
{
  const tmpl: BillingProduct[] = [
    { productId: "sub-manual", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "sub-auto-web", lineItemDescription: `${B}::Dealer B`, quantity: 1 },
    { productId: "labels", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
  ];
  const out = planGroupTierChange(tmpl, A, "Dealer A", dms);
  check("A's old sub-manual line removed", !out.some((p) => p.productId === "sub-manual"), ids(out));
  check("A now has sub-auto-dms", has(out, "sub-auto-dms", `${A}::Dealer A`), ids(out));
  check("A gets a dms-setup line", has(out, "dms-setup", `${A}::dms-setup`), ids(out));
  check("B's sub-auto-web untouched", has(out, "sub-auto-web", `${B}::Dealer B`), ids(out));
  check("A's labels line preserved", has(out, "labels", `${A}::Dealer A`), ids(out));
}
{
  // Downgrade DMS→Web should NOT add a dms-setup, and should drop A's sub line only.
  const tmpl: BillingProduct[] = [
    { productId: "sub-auto-dms", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "dms-setup", lineItemDescription: `${A}::dms-setup`, quantity: 1 },
  ];
  const out = planGroupTierChange(tmpl, A, "Dealer A", web);
  check("DMS→Web: A now sub-auto-web", has(out, "sub-auto-web", `${A}::Dealer A`), ids(out));
  check("DMS→Web: existing dms-setup preserved (one-time)", has(out, "dms-setup", `${A}::dms-setup`), ids(out));
  check("DMS→Web: exactly one dms-setup (no dup)", out.filter((p) => p.productId === "dms-setup").length === 1, ids(out));
}

// ── Group cancel ─────────────────────────────────────────────────────────────
console.log("planGroupCancel:");
{
  // Non-last: B still has a sub → safe to write.
  const tmpl: BillingProduct[] = [
    { productId: "sub-manual", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "dms-setup", lineItemDescription: `${A}::dms-setup`, quantity: 1 },
    { productId: "sub-auto-web", lineItemDescription: `${B}::Dealer B`, quantity: 1 },
    { productId: "labels", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
  ];
  const r = planGroupCancel(tmpl, A);
  check("non-last: changed", r.changed);
  check("non-last: NOT blocked", !r.blocked);
  check("non-last: A's sub removed", !r.remaining.some((p) => p.productId === "sub-manual"), ids(r.remaining));
  check("non-last: A's dms-setup removed", !r.remaining.some((p) => p.productId === "dms-setup"), ids(r.remaining));
  check("non-last: A's labels line kept", has(r.remaining, "labels", `${A}::Dealer A`), ids(r.remaining));
  check("non-last: B's sub kept", has(r.remaining, "sub-auto-web", `${B}::Dealer B`), ids(r.remaining));
}
{
  // Last sub in the template → blocked, no safe write.
  const tmpl: BillingProduct[] = [
    { productId: "sub-manual", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "labels", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
  ];
  const r = planGroupCancel(tmpl, A);
  check("last-sub: changed", r.changed);
  check("last-sub: BLOCKED", r.blocked);
}
{
  // Dealer not in template → noop (no change).
  const tmpl: BillingProduct[] = [{ productId: "sub-auto-web", lineItemDescription: `${B}::Dealer B`, quantity: 1 }];
  const r = planGroupCancel(tmpl, A);
  check("noop: not changed", !r.changed);
  check("noop: not blocked", !r.blocked);
}

// ── Dealer-own merge ────────────────────────────────────────────────────────
console.log("planDealerMerge:");
{
  const sub: BillingProduct = { productId: man.key, name: man.name, quantity: 1, lineItemDescription: `${A}::Dealer A` };
  const fresh = planDealerMerge(null, sub, man.key, A);
  check("fresh template = just the sub line", fresh.length === 1 && fresh[0].productId === "sub-manual", ids(fresh));
}
{
  const existing: BillingProduct[] = [
    { productId: "sub-manual", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "labels", lineItemDescription: `${A}::Dealer A`, quantity: 1 },
    { productId: "dms-setup", lineItemDescription: `${A}::dms-setup`, quantity: 1 },
  ];
  const sub: BillingProduct = { productId: web.key, name: web.name, quantity: 1, lineItemDescription: `${A}::Dealer A` };
  const out = planDealerMerge(existing, sub, web.key, A);
  check("merge: old sub-manual replaced by sub-auto-web", out.some((p) => p.productId === "sub-auto-web") && !out.some((p) => p.productId === "sub-manual"), ids(out));
  check("merge: labels preserved", out.some((p) => p.productId === "labels"), ids(out));
  check("merge: existing dms-setup preserved, no dup", out.filter((p) => p.productId === "dms-setup").length === 1, ids(out));
}
{
  // Upgrade to DMS with no prior dms-setup → adds it.
  const existing: BillingProduct[] = [{ productId: "sub-manual", lineItemDescription: `${A}::Dealer A`, quantity: 1 }];
  const sub: BillingProduct = { productId: dms.key, name: dms.name, quantity: 1, lineItemDescription: `${A}::Dealer A` };
  const out = planDealerMerge(existing, sub, dms.key, A);
  check("merge→DMS: dms-setup added", has(out, "dms-setup", `${A}::dms-setup`), ids(out));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
