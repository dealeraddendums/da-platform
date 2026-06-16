// Phase 13b — migration readiness computation (READ-ONLY view; step 1).
// Spec: docs/phase-13-self-serve-migration.md → "13b detailed".
//
// Readiness is COMPUTED from existing data. The only human input is the
// operator-set `template_confirmed` flag (and the `migration_complex` escape
// hatch). A dealer is invite-ready (step 2, not built yet) only when ALL gates
// are green.

// White-glove exclusion list — these complex groups stay operator-driven, never
// self-serve (Allan, 2026-06-12). Matched case-insensitively as a substring of
// the group name so "AVIA LLC" / "Ourisman Automotive Group" / "Lithia …" all hit.
export const WHITE_GLOVE_GROUP_PATTERNS = ['dealer general', 'avia', 'ourisman', 'lithia'] as const;

export function isWhiteGloveGroup(groupName: string | null | undefined): boolean {
  if (!groupName) return false;
  const n = groupName.toLowerCase();
  return WHITE_GLOVE_GROUP_PATTERNS.some((p) => n.includes(p));
}

export interface ReadinessDealer {
  id: string;
  dealer_id: string;
  name: string;
  state: string | null;
  group_id: string | null;
  account_purpose: string | null;
  is_test: boolean | null;
  migration_status: string | null;
  migration_complex: boolean | null;
  template_confirmed: boolean | null;
  subscription_billed_to: string | null;
  billing_customer_id: string | null;
  logo_url: string | null;
  // core ETL fields used by the etl-complete check
  address: string | null;
  city: string | null;
  zip: string | null;
  inventory_dealer_id: string | null;
}

export interface BillingTemplateInfo {
  active?: boolean;
  nextInvoiceDate?: string | null;
}

export interface ReadinessRow {
  id: string;
  dealer_id: string;
  name: string;
  groupName: string | null;
  state: string | null;
  etlComplete: boolean;
  etlMissing: string[];        // which ETL sub-checks failed (for the tooltip)
  billingStaged: boolean;
  billingReason: string;       // human note: staged / missing / active / past-date / no-customer
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;      // why not eligible (white-glove group / complex / migrated / test)
  ready: boolean;              // ALL green
}

const present = (v: string | null | undefined) => !!(v && String(v).trim().length);

/** Future-date check for the no-double-bill guardrail. `now` injected for testability. */
function isFutureDate(d: string | null | undefined, now: number): boolean {
  if (!d) return false;
  const t = Date.parse(d);
  return Number.isFinite(t) && t > now;
}

export function computeReadiness(
  d: ReadinessDealer,
  ctx: {
    groupName: string | null;
    groupBillingCustomerId: string | null;
    hasProfile: boolean;
    hasSettings: boolean;
    billingByCustomer: Map<string, BillingTemplateInfo>;
    now: number;
  },
): ReadinessRow {
  // ── ETL complete ─────────────────────────────────────────────────────────
  // Cheap, batchable signals: core dealer record + logo + a settings row + a
  // user. (Inventory vehicles/options come from the nightly ETL and aren't
  // live-counted here in step 1 — see the route's note.)
  const etlMissing: string[] = [];
  if (!present(d.name)) etlMissing.push('name');
  if (!present(d.address) || !present(d.city) || !present(d.state) || !present(d.zip)) etlMissing.push('address');
  if (!present(d.inventory_dealer_id)) etlMissing.push('inventory id');
  if (!present(d.logo_url)) etlMissing.push('logo');
  if (!ctx.hasSettings) etlMissing.push('settings');
  if (!ctx.hasProfile) etlMissing.push('users');
  const etlComplete = etlMissing.length === 0;

  // ── Billing template staged ───────────────────────────────────────────────
  // Group-billed dealers stage on the GROUP's customer; else their own.
  const billedToGroup = d.subscription_billed_to === 'group';
  const customerId = billedToGroup ? ctx.groupBillingCustomerId : d.billing_customer_id;
  let billingStaged = false;
  let billingReason: string;
  if (!customerId) {
    billingReason = billedToGroup ? 'no group billing customer' : 'no billing customer';
  } else {
    const tmpl = ctx.billingByCustomer.get(customerId);
    if (!tmpl) billingReason = 'no template';
    else if (tmpl.active !== false) billingReason = 'template active (should be paused)';
    else if (!isFutureDate(tmpl.nextInvoiceDate, ctx.now)) billingReason = 'nextInvoiceDate not in future';
    else { billingStaged = true; billingReason = 'staged'; }
  }

  // ── Eligible ───────────────────────────────────────────────────────────────
  let eligible = true;
  let eligibleReason = 'eligible';
  if (d.migration_status === 'migrated') { eligible = false; eligibleReason = 'already migrated'; }
  else if (d.is_test || (d.account_purpose && d.account_purpose !== 'real')) { eligible = false; eligibleReason = 'test/demo account'; }
  else if (isWhiteGloveGroup(ctx.groupName)) { eligible = false; eligibleReason = `white-glove group (${ctx.groupName})`; }
  else if (d.migration_complex) { eligible = false; eligibleReason = 'flagged complex'; }

  const templateConfirmed = !!d.template_confirmed;
  const ready = etlComplete && billingStaged && templateConfirmed && eligible;

  return {
    id: d.id, dealer_id: d.dealer_id, name: d.name, groupName: ctx.groupName, state: d.state,
    etlComplete, etlMissing, billingStaged, billingReason,
    templateConfirmed, eligible, eligibleReason, ready,
  };
}
