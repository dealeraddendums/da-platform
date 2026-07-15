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

/**
 * Trial-track account for readiness purposes: explicit "Trial", the legacy
 * "Trial Expired" label, or null (the unset default = fresh trial). Mirrors
 * lib/print-eligibility.ts isTrialAccountType plus the "Trial Expired" form.
 */
export function isTrialTrackAccount(accountType: string | null | undefined): boolean {
  if (accountType == null) return true;
  return accountType.split(' $')[0].trim().toLowerCase().startsWith('trial');
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
  active?: boolean | null;
  migration_complex: boolean | null;
  template_confirmed: boolean | null;
  account_type: string | null;
  subscription_billed_to: string | null;
  billing_customer_id: string | null;
  logo_url: string | null;
  primary_contact_email: string | null;
  invited_at: string | null;
  // core ETL fields used by the etl-complete check
  address: string | null;
  city: string | null;
  zip: string | null;
  inventory_dealer_id: string | null;
}

export interface BillingTemplateInfo {
  active?: boolean;
  nextInvoiceDate?: string | null;
  billingState?: string;
}

export interface ReadinessRow {
  id: string;
  dealer_id: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
  state: string | null;
  // ── HARD gates (these three determine `ready`) ──────────────────────────
  billingStaged: boolean;
  billingReason: string;       // human note: staged / missing / active / past-date / no-customer / n-a trial
  /** False for Trial-track dealers — nothing to bill until they upgrade, so
   *  billing staging can't gate them. UI shows "—" instead of a check. */
  billingApplicable: boolean;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;      // why not eligible (white-glove group / complex / migrated / test)
  ready: boolean;              // billingStaged && templateConfirmed && eligible
  // ── WARNINGS (informational only — never block `ready`) ──────────────────
  settingsMissing: boolean;    // no dealer_settings row (migration creates one — Step 5)
  logoMissing: boolean;        // no logo_url (optional / addable later)
  zeroInventory: boolean;      // no synced products/options (vehicle_options) — assumed from nightly ETL
  warnings: string[];          // labels for the ones that are true, for display/tooltip
  // ── Invite lifecycle (Phase 13b step 3; populated by loadReadinessRows) ─────
  inviteStatus: InviteStatus;
  invitedAt: string | null;
  waveId: string | null;
  // ── 13d: legacy FreshBooks recurring-stop tracking (operator-managed) ───────
  freshbooksStoppedAt: string | null;
  freshbooksStopPending: boolean; // migrated but FreshBooks recurring not yet stopped
  // ── operator assignment (who owns this dealer's migration) ──────────────────
  assignedTo: string | null;
  // ── staging: raw dealers.migration_status ('pending' = ETL frozen, queued) ──
  migrationStatus: string | null;
}

export type InviteStatus = "not-invited" | "invited" | "stalled" | "expired" | "migrated";

export const STALL_DAYS = 7; // invited but not migrated after this → "stalled"

/**
 * Current invite-lifecycle status for a dealer (Phase 13b step 3). Our confirm is
 * atomic (accept + migrate in one step), so there's no separate "accepted" state
 * — invited → migrated, with "stalled"/"expired" for invites that go cold.
 */
export function computeInviteStatus(
  migrationStatus: string | null,
  invitedAt: string | null,
  invitation: { accepted_at: string | null; expires_at: string | null } | null,
  now: number,
): InviteStatus {
  if (migrationStatus === "migrated") return "migrated";
  if (!invitation && migrationStatus !== "invited") return "not-invited";
  if (!invitation) return "invited"; // status says invited but no row (legacy/edge) — treat as invited
  if (invitation.accepted_at) return "migrated"; // consumed → migrated
  if (invitation.expires_at && Date.parse(invitation.expires_at) < now) return "expired";
  const stamp = invitedAt ?? null;
  if (stamp && now - Date.parse(stamp) > STALL_DAYS * 24 * 60 * 60 * 1000) return "stalled";
  return "invited";
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
    hasSettings: boolean;
    hasOptions: boolean;
    hasDealerAdmin: boolean;
    billingByCustomer: Map<string, BillingTemplateInfo>;
    now: number;
    invitation?: { accepted_at: string | null; expires_at: string | null; wave_id?: string | null } | null;
    freshbooksStoppedAt?: string | null;
    assignedTo?: string | null;
  },
): ReadinessRow {
  // ── WARNINGS (informational only — softened 2026-06-16; do NOT block ready) ─
  // The migration handles these: it creates a default dealer_settings row
  // (procedure Step 5), a logo is optional/addable later, and inventory is
  // synced by the nightly ETL. Flag them so the operator sees them, never gate.
  const settingsMissing = !ctx.hasSettings;
  const logoMissing = !present(d.logo_url);
  const zeroInventory = !ctx.hasOptions;
  const warnings: string[] = [];
  if (settingsMissing) warnings.push('no settings row');
  if (logoMissing) warnings.push('no logo');
  if (zeroInventory) warnings.push('no synced products');

  // ── Billing template staged ───────────────────────────────────────────────
  // Trial-track dealers (account_type 'Trial' / 'Trial Expired' / null) have
  // nothing to bill until they upgrade to Paid — da-billing staging is N/A and
  // must never gate their migration. canPrint handles Trial vs Paid on its own.
  const billingApplicable = !isTrialTrackAccount(d.account_type);
  // Group-billed dealers stage on the GROUP's customer; else their own.
  const billedToGroup = d.subscription_billed_to === 'group';
  const customerId = billedToGroup ? ctx.groupBillingCustomerId : d.billing_customer_id;
  let billingStaged = false;
  let billingReason: string;
  if (!billingApplicable) {
    billingStaged = true;
    billingReason = 'n/a — trial account (no billing until upgrade)';
  } else if (!customerId) {
    billingReason = billedToGroup ? 'no group billing customer' : 'no billing customer';
  } else {
    const tmpl = ctx.billingByCustomer.get(customerId);
    if (!tmpl) {
      billingReason = 'no template';
    } else {
      // Billing is "staged" for migration when the da-billing customer is in
      // Setup Mode (billingState==='setup', introduced 2026-06-27) — or, for the
      // legacy paused-template model, when the template is inactive. Live billing
      // (billingState==='active', the default when the field is absent) is NOT
      // staged and must not be invite-ready.
      const isSetupMode = tmpl.active === false || tmpl.billingState === 'setup';
      if (!isSetupMode) billingReason = 'billing not in setup mode (go live not set, or not in da-billing yet)';
      else if (!isFutureDate(tmpl.nextInvoiceDate, ctx.now)) billingReason = 'nextInvoiceDate not in future';
      else { billingStaged = true; billingReason = 'staged'; }
    }
  }

  // ── Eligible ───────────────────────────────────────────────────────────────
  // 13c: a self-serve invite needs a deliverable contact (the dealer's own
  // primary email or a dealer_admin user). A group-member dealer with neither is
  // operated by the group as a service (service-provider model) and never
  // self-serves → route to white-glove, don't invite.
  const hasSelfServeContact = present(d.primary_contact_email) || ctx.hasDealerAdmin;
  let eligible = true;
  let eligibleReason = 'eligible';
  if (d.migration_status === 'migrated') { eligible = false; eligibleReason = 'already migrated'; }
  // Deactivated dealers (e.g. Dealer General rooftops out of the paid+active
  // scope, 2026-07-14) never migrate — blocks wave-send and claim-next too.
  else if (d.active === false) { eligible = false; eligibleReason = 'deactivated dealer'; }
  else if (d.is_test || (d.account_purpose && d.account_purpose !== 'real')) { eligible = false; eligibleReason = 'test/demo account'; }
  else if (isWhiteGloveGroup(ctx.groupName)) { eligible = false; eligibleReason = `white-glove group (${ctx.groupName})`; }
  else if (d.migration_complex) { eligible = false; eligibleReason = 'flagged complex'; }
  else if (!hasSelfServeContact) { eligible = false; eligibleReason = 'no self-serve contact (operator/group-managed)'; }

  // ── Ready = the THREE hard gates only (warnings excluded) ──────────────────
  const templateConfirmed = !!d.template_confirmed;
  const ready = billingStaged && templateConfirmed && eligible;

  const inviteStatus = computeInviteStatus(d.migration_status, d.invited_at, ctx.invitation ?? null, ctx.now);

  return {
    id: d.id, dealer_id: d.dealer_id, name: d.name, groupId: d.group_id ?? null, groupName: ctx.groupName, state: d.state,
    billingStaged, billingReason, billingApplicable, templateConfirmed, eligible, eligibleReason, ready,
    settingsMissing, logoMissing, zeroInventory, warnings,
    inviteStatus, invitedAt: d.invited_at ?? null, waveId: ctx.invitation?.wave_id ?? null,
    freshbooksStoppedAt: ctx.freshbooksStoppedAt ?? null,
    freshbooksStopPending: inviteStatus === "migrated" && !ctx.freshbooksStoppedAt,
    assignedTo: ctx.assignedTo ?? null,
    migrationStatus: d.migration_status ?? null,
  };
}
