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
  /** True = created ON 5.0 (migration 138) — status 'migrated' without a 4.0 past. */
  is_native?: boolean | null;
  active?: boolean | null;
  migration_complex: boolean | null;
  template_confirmed: boolean | null;
  account_type: string | null;
  subscription_billed_to: string | null;
  billing_customer_id: string | null;
  logo_url: string | null;
  primary_contact_email: string | null;
  invited_at: string | null;
  /** Manual Aurora sync stamp (migration 130) — set by POST /api/migration/sync. */
  last_synced_at?: string | null;
  /** Operator attestation "da-billing verified correct" (migration 145).
   *  undefined = column not applied yet → fall back to the auto-detected check. */
  billing_verified?: boolean | null;
  /** Deliberate Aurora-sync freeze — 5.0 config is hand-managed. */
  etl_locked?: boolean | null;
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
  /** THE billing gate. Since migration 145 this is the OPERATOR CHECKBOX
   *  (dealers.billing_verified), not the auto-detected staging check — the
   *  invite now fires the billing cutover, so a human attests first. Falls
   *  back to the auto-check only while the column is missing. Name kept so
   *  every downstream gate (ready, wave-send, migrate-group) inherits. */
  billingStaged: boolean;
  billingReason: string;       // hover text: operator state + the auto-check detail
  /** False for Trial-track dealers — nothing to bill until they upgrade — and
   *  for 5.0-native dealers (no 4.0 billing to cut over). UI shows "—". */
  billingApplicable: boolean;
  /** The raw operator checkbox value (false when the column is missing). */
  billingVerified: boolean;
  /** The pre-145 auto-detected staging state, kept as the hover hint. */
  billingAutoStaged: boolean;
  billingAutoReason: string;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;      // why not eligible (white-glove group / complex / migrated / test)
  /** Fourth hard gate (2026-07-17): the dealer's 4.0 data has been pulled via
   *  the manual Sync action (last_synced_at set), or the dealer was staged
   *  ('pending') before the sync model — both mean "prepared, nothing will
   *  overwrite them". The nightly ETL no longer refreshes config, so an
   *  unsynced dealer may carry stale settings/products — sync before invite.
   *  etl_locked dealers (own flag or group's) COUNT AS SYNCED (2026-08-10):
   *  the lock exists because their 5.0 config is hand-managed truth — there
   *  is nothing to sync, and the ETL refuses them anyway. */
  synced: boolean;
  /** Deliberate Aurora-sync freeze (dealer flag or group cascade) — console
   *  shows a 🔒 chip instead of the sync link. */
  etlLocked: boolean;
  ready: boolean;              // synced && billingStaged && templateConfirmed && eligible
  // ── WARNINGS (informational only — never block `ready`) ──────────────────
  settingsMissing: boolean;    // no dealer_settings row (migration creates one — Step 5)
  logoMissing: boolean;        // no logo_url (optional / addable later)
  zeroInventory: boolean;      // no synced products/options (vehicle_options) — assumed from nightly ETL
  warnings: string[];          // labels for the ones that are true, for display/tooltip
  // ── Invite lifecycle (Phase 13b step 3; populated by loadReadinessRows) ─────
  inviteStatus: InviteStatus;
  invitedAt: string | null;
  waveId: string | null;
  /** Emails the migration invite went to (multi-recipient, 2026-08-04);
   *  "✓"-suffixed when that recipient completed their invitation. */
  inviteRecipients: string[];
  // ── 13d: legacy FreshBooks recurring-stop tracking (operator-managed) ───────
  freshbooksStoppedAt: string | null;
  freshbooksStopPending: boolean; // migrated but FreshBooks recurring not yet stopped (never for natives)
  /** The automatic 4.0 migrated_to_v5 lockout call failed / endpoint missing —
   *  operator flips the 4.0 admin toggle manually (migration 146). */
  legacyLockoutPending: boolean;
  /** True = born on 5.0 (migration 138): console shows "5.0 native", no FreshBooks affordances. */
  isNative: boolean;
  // ── operator assignment (who owns this dealer's migration) ──────────────────
  assignedTo: string | null;
  // ── staging: raw dealers.migration_status ('pending' = synced/prepared) ─────
  migrationStatus: string | null;
  /** When the manual Sync last ran for this dealer (migration 130). */
  lastSyncedAt: string | null;
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
    groupEtlLocked?: boolean;
    hasSettings: boolean;
    hasOptions: boolean;
    hasDealerAdmin: boolean;
    billingByCustomer: Map<string, BillingTemplateInfo>;
    now: number;
    invitation?: { accepted_at: string | null; expires_at: string | null; wave_id?: string | null } | null;
    inviteRecipients?: string[];
    freshbooksStoppedAt?: string | null;
    legacyLockoutPending?: boolean;
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

  // ── Billing gate ─────────────────────────────────────────────────────────
  // Trial-track dealers (account_type 'Trial' / 'Trial Expired' / null) have
  // nothing to bill until they upgrade to Paid, and 5.0-native dealers have no
  // 4.0 billing to cut over — the gate is N/A for both and must never block
  // them. canPrint handles Trial vs Paid on its own.
  const billingApplicable = !isTrialTrackAccount(d.account_type) && d.is_native !== true;
  // Auto-detected staging state (the pre-migration-145 gate) — computed for
  // the hover hint. Group-billed dealers stage on the GROUP's customer.
  const billedToGroup = d.subscription_billed_to === 'group';
  const customerId = billedToGroup ? ctx.groupBillingCustomerId : d.billing_customer_id;
  let billingAutoStaged = false;
  let billingAutoReason: string;
  if (!customerId) {
    billingAutoReason = billedToGroup ? 'no group billing customer' : 'no billing customer';
  } else {
    const tmpl = ctx.billingByCustomer.get(customerId);
    if (!tmpl) {
      billingAutoReason = 'no template';
    } else {
      // "Staged" = customer in Setup Mode (billingState==='setup', 2026-06-27)
      // or, legacy paused-template model, template inactive — with a FUTURE
      // nextInvoiceDate. Live billing also reads as sensible here (already cut
      // over), so the auto state is a hint, not the gate.
      const isSetupMode = tmpl.active === false || tmpl.billingState === 'setup';
      if (!isSetupMode) billingAutoReason = 'billing already live (or not in setup mode)';
      else if (!isFutureDate(tmpl.nextInvoiceDate, ctx.now)) billingAutoReason = 'staged but nextInvoiceDate not in future';
      else { billingAutoStaged = true; billingAutoReason = 'staged (setup mode, future nextInvoiceDate)'; }
    }
  }
  // THE gate (migration 145): the operator checkbox. While the column is
  // missing (undefined), fall back to the auto check so a code deploy ahead of
  // the SQL doesn't flip the fleet to not-ready.
  const billingVerified = d.billing_verified === true;
  const verifiedColumnPresent = d.billing_verified !== undefined;
  let billingStaged: boolean;
  let billingReason: string;
  if (!billingApplicable) {
    billingStaged = true;
    billingReason = d.is_native === true
      ? 'n/a — created on 5.0 (no billing cutover)'
      : 'n/a — trial account (no billing until upgrade)';
  } else if (!verifiedColumnPresent) {
    billingStaged = billingAutoStaged;
    billingReason = `${billingAutoReason} (billing_verified column missing — apply migration 145)`;
  } else {
    billingStaged = billingVerified;
    billingReason = billingVerified
      ? `operator-verified · auto-check: ${billingAutoReason}`
      : `not verified by operator · auto-check: ${billingAutoReason}`;
  }

  // ── Eligible ───────────────────────────────────────────────────────────────
  // 13c: a self-serve invite needs a deliverable contact (the dealer's own
  // primary email or a dealer_admin user). A group-member dealer with neither is
  // operated by the group as a service (service-provider model) and never
  // self-serves → route to white-glove, don't invite.
  const hasSelfServeContact = present(d.primary_contact_email) || ctx.hasDealerAdmin;
  let eligible = true;
  let eligibleReason = 'eligible';
  if (d.migration_status === 'migrated') { eligible = false; eligibleReason = d.is_native === true ? 'created on 5.0 — nothing to migrate' : 'already migrated'; }
  // Deactivated dealers (e.g. Dealer General rooftops out of the paid+active
  // scope, 2026-07-14) never migrate — blocks wave-send and claim-next too.
  else if (d.active === false) { eligible = false; eligibleReason = 'deactivated dealer'; }
  else if (d.is_test || (d.account_purpose && d.account_purpose !== 'real')) { eligible = false; eligibleReason = 'test/demo account'; }
  else if (isWhiteGloveGroup(ctx.groupName)) { eligible = false; eligibleReason = `white-glove group (${ctx.groupName})`; }
  else if (d.migration_complex) { eligible = false; eligibleReason = 'flagged complex'; }
  else if (!hasSelfServeContact) { eligible = false; eligibleReason = 'no self-serve contact (operator/group-managed)'; }

  // ── Ready = the FOUR hard gates only (warnings excluded) ───────────────────
  // synced: manual Sync ran (last_synced_at) OR the dealer reached 'pending'/
  // beyond before the sync model (staged, invited, migrating) — those were
  // prepared under the old flow and must not lose readiness retroactively.
  const templateConfirmed = !!d.template_confirmed;
  // etl_locked (own or group) satisfies the Synced gate: the freeze exists
  // because the dealer's 5.0 config is already the hand-managed truth —
  // there is nothing to pull from Aurora (the ETL refuses them by design).
  const etlLocked = d.etl_locked === true || ctx.groupEtlLocked === true;
  const synced = !!d.last_synced_at
    || etlLocked
    || d.migration_status === 'pending'
    || d.migration_status === 'invited'
    || d.migration_status === 'migrating';
  const ready = synced && billingStaged && templateConfirmed && eligible;

  const inviteStatus = computeInviteStatus(d.migration_status, d.invited_at, ctx.invitation ?? null, ctx.now);

  return {
    id: d.id, dealer_id: d.dealer_id, name: d.name, groupId: d.group_id ?? null, groupName: ctx.groupName, state: d.state,
    billingStaged, billingReason, billingApplicable, billingVerified, billingAutoStaged, billingAutoReason,
    templateConfirmed, eligible, eligibleReason, synced, etlLocked, ready,
    settingsMissing, logoMissing, zeroInventory, warnings,
    inviteStatus, invitedAt: d.invited_at ?? null, waveId: ctx.invitation?.wave_id ?? null,
    inviteRecipients: ctx.inviteRecipients ?? [],
    freshbooksStoppedAt: ctx.freshbooksStoppedAt ?? null,
    // Natives never had FreshBooks — nothing to stop, never "pending".
    freshbooksStopPending: inviteStatus === "migrated" && !ctx.freshbooksStoppedAt && d.is_native !== true,
    legacyLockoutPending: ctx.legacyLockoutPending === true && d.is_native !== true,
    isNative: d.is_native === true,
    assignedTo: ctx.assignedTo ?? null,
    migrationStatus: d.migration_status ?? null,
    lastSyncedAt: d.last_synced_at ?? null,
  };
}
