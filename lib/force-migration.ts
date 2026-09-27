// Force-migration queue + verdict logic. Spec: suite root force-migration-spec.md.
//
// The queue is the SAFETY SURFACE. Its whole job is to make sure a team member
// never force-migrates a dealer who would land somewhere broken:
//   * READY   — their 5.0 setup is actually usable (synced · template · billing)
//   * REACHABLE — we can still email them, because after the force their ONLY
//     way in is the sign-in code we email. A forced dealer with a dead address
//     is locked out of BOTH platforms.
//   * MAPPABLE — we can name their dealership to 4.0. The flag is keyed on the
//     legacy DEALER_ID; if 4.0 doesn't recognise it the force aborts rather
//     than half-migrating (verified 2026-09-27: dealers.dealer_id is the key).
//
// Nothing here writes. The verdict function is pure so it can be unit-tested.

import { loadReadinessRows } from "@/lib/migration-readiness-data";
import type { ReadinessRow } from "@/lib/migration-readiness";
import { createAdminSupabaseClient } from "@/lib/db";
import { checkDeliverability, type DeliverabilityState } from "@/lib/mandrill";

/** How long a forced dealer stays visible in the queue so un-force is reachable. */
export const RECENT_FORCE_DAYS = 30;

export type ForceVerdict = "safe" | "not-ready" | "unreachable" | "excluded" | "held";

export const VERDICT_LABEL: Record<ForceVerdict, string> = {
  safe: "SAFE TO FORCE",
  "not-ready": "NOT READY",
  unreachable: "UNREACHABLE",
  excluded: "EXCLUDED",
  held: "ON HOLD",
};

export interface ForceCandidate {
  /** Readiness gates, straight from the migration console's own logic. */
  synced: boolean;
  billingStaged: boolean;
  billingApplicable: boolean;
  templateConfirmed: boolean;
  eligible: boolean;
  eligibleReason: string;
  /** dealers.final_notice_at — the day-23 mandatory notice actually sent. */
  finalNoticeAt: string | null;
  /** dealers.force_hold */
  hold: boolean;
  /** Mandrill denylist state for the dealer's invite recipients. */
  deliverability: DeliverabilityState;
  /** The legacy 4.0 DEALER_ID we'd send (dealers.dealer_id). */
  legacyDealerId: string | null;
  /** Any address at all to notify. */
  hasRecipient: boolean;
}

export interface ForceDecision {
  verdict: ForceVerdict;
  /** Ordered, human-readable — the UI shows these as the "why not" list. */
  reasons: string[];
}

/**
 * The single gate. Called by the queue (to render) AND by the force endpoint
 * (to re-check at click time) so the button and the server can never disagree.
 *
 * Order is deliberate: EXCLUDED and HELD are statements about whether this
 * dealer should be force-migrated at all, so they outrank setup problems —
 * telling an operator to "fix billing" on a dealer that must never be forced
 * individually would send them off to do pointless work.
 */
export function computeForceVerdict(c: ForceCandidate): ForceDecision {
  const reasons: string[] = [];

  // 1. Should this dealer be individually forced at all?
  if (!c.eligible) return { verdict: "excluded", reasons: [c.eligibleReason] };
  if (c.hold) return { verdict: "held", reasons: ["parked by an operator"] };

  // 2. Have they actually been told? No final notice = not in scope, ever.
  if (!c.finalNoticeAt) {
    return { verdict: "not-ready", reasons: ["day-23 final notice not sent yet"] };
  }

  // 3. Can we even name them to 4.0? A missing id means the force would 404
  //    and abort — surface it here instead of at click time.
  if (!c.legacyDealerId || !c.legacyDealerId.trim()) {
    return { verdict: "not-ready", reasons: ["no legacy 4.0 DEALER_ID on the dealer record"] };
  }

  // 4. Will 5.0 actually work for them?
  if (!c.synced) reasons.push("not synced from 4.0");
  if (!c.templateConfirmed) reasons.push("template not confirmed");
  if (c.billingApplicable && !c.billingStaged) reasons.push("billing not verified");
  if (reasons.length) return { verdict: "not-ready", reasons };

  // 5. Can they get in afterwards? This is last because it's the one gate the
  //    operator fixes by changing the dealer's email, not their setup.
  if (!c.hasRecipient) return { verdict: "unreachable", reasons: ["no contact email on file"] };
  if (c.deliverability === "bounced") return { verdict: "unreachable", reasons: ["email is on the bounce/denylist"] };
  if (c.deliverability === "unknown") {
    return { verdict: "unreachable", reasons: ["could not confirm the email is deliverable"] };
  }

  return { verdict: "safe", reasons: [] };
}

export interface ForceQueueRow {
  id: string;
  dealerId: string;
  name: string;
  groupName: string | null;
  accountType: string | null;
  invitedAt: string | null;
  finalNoticeAt: string | null;
  daysSinceInvite: number | null;
  synced: boolean;
  billingStaged: boolean;
  billingApplicable: boolean;
  templateConfirmed: boolean;
  recipients: string[];
  deliverability: DeliverabilityState;
  deliverabilityDetail: string | null;
  hold: boolean;
  holdReason: string | null;
  forcedAt: string | null;
  verdict: ForceVerdict;
  reasons: string[];
}

interface ForceFlags {
  final_notice_at: string | null;
  force_hold: boolean | null;
  force_hold_reason: string | null;
  forced_at: string | null;
  account_type: string | null;
  primary_contact_email: string | null;
}

/** Per-dealer force flags (migration 161), keyed by dealers.id. */
export async function loadForceFlags(dealerIds?: string[]): Promise<Map<string, ForceFlags>> {
  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = (admin.from("dealers") as any)
    .select("id, final_notice_at, force_hold, force_hold_reason, forced_at, account_type, primary_contact_email");
  if (dealerIds?.length) q = q.in("id", dealerIds);
  const { data, error } = await q;
  if (error) throw new Error(`force flags unavailable (migration 161 applied?): ${error.message}`);
  const map = new Map<string, ForceFlags>();
  for (const r of (data ?? []) as Array<ForceFlags & { id: string }>) map.set(r.id, r);
  return map;
}

/**
 * Who we would actually email. loadReadinessRows marks completed recipients with
 * a trailing "✓", so that is stripped. The dealer's primary_contact_email is
 * merged in as well: an invited dealer whose invitation row has aged out still
 * has a reachable address, and the notify step already falls back to it — if the
 * verdict ignored it, that dealer would read UNREACHABLE while we could in fact
 * email them perfectly well.
 */
export function resolveRecipients(list: string[] | undefined, primaryContactEmail?: string | null): string[] {
  const out = (list ?? [])
    .map((r) => r.replace(/\s*✓\s*$/, "").trim())
    .filter((r) => r.includes("@"));
  const primary = (primaryContactEmail ?? "").trim();
  if (primary.includes("@") && !out.some((e) => e.toLowerCase() === primary.toLowerCase())) out.push(primary);
  return out;
}

/**
 * Build the Force Migration queue: invited dealers whose day-23 final notice
 * has sent. Deliverability is checked live against Mandrill (bounded
 * concurrency) — it's the gate most likely to have changed since yesterday.
 */
export async function loadForceQueue(): Promise<{ rows: ForceQueueRow[]; checkedEmails: number }> {
  const { rows } = await loadReadinessRows();
  const flags = await loadForceFlags();

  // Invited dealers that have had the mandatory final notice — PLUS dealers we
  // have already forced. A forced dealer flips to migration_status 'migrated',
  // so filtering on 'invited' alone made the row vanish the instant the force
  // succeeded, which is exactly when an operator is most likely to want it back:
  // un-force was unreachable from the one screen that promises it. Forced rows
  // stay visible for RECENT_FORCE_DAYS, compute as EXCLUDED ("already
  // migrated") so the Force button never re-renders, and carry the Un-force
  // affordance.
  const forcedCutoff = Date.now() - RECENT_FORCE_DAYS * 86_400_000;
  const candidates = rows.filter((r) => {
    const f = flags.get(r.id);
    if (!f) return false;
    if (f.forced_at && Date.parse(f.forced_at) >= forcedCutoff) return true;
    return r.migrationStatus === "invited" && !!f.final_notice_at;
  });

  const now = Date.now();
  const out: ForceQueueRow[] = [];
  let checkedEmails = 0;

  // Deliverability in small batches so a 200-row queue doesn't open 200 sockets.
  const BATCH = 8;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async (r: ReadinessRow) => {
      const f = flags.get(r.id)!;
      const recipients = resolveRecipients(r.inviteRecipients, f.primary_contact_email);
      // Reachable if ANY recipient is deliverable — one good address is enough
      // to send the "you're on 5.0" email and for them to request a code.
      let state: DeliverabilityState = "unknown";
      let detail: string | null = null;
      if (recipients.length) {
        const checks = await Promise.all(recipients.map((e) => checkDeliverability(e)));
        checkedEmails += checks.length;
        if (checks.some((c) => c.state === "ok")) state = "ok";
        else if (checks.every((c) => c.state === "bounced")) {
          state = "bounced";
          detail = checks.map((c, idx) => `${recipients[idx]}: ${c.reason ?? "denylisted"}`).join("; ");
        } else {
          state = "unknown";
          detail = checks.find((c) => c.detail)?.detail ?? null;
        }
      }

      const decision = computeForceVerdict({
        synced: r.synced,
        billingStaged: r.billingStaged,
        billingApplicable: r.billingApplicable,
        templateConfirmed: r.templateConfirmed,
        eligible: r.eligible,
        eligibleReason: r.eligibleReason,
        finalNoticeAt: f.final_notice_at,
        hold: !!f.force_hold,
        deliverability: state,
        legacyDealerId: r.dealer_id,
        hasRecipient: recipients.length > 0,
      });

      const row: ForceQueueRow = {
        id: r.id,
        dealerId: r.dealer_id,
        name: r.name,
        groupName: r.groupName,
        accountType: f.account_type,
        invitedAt: r.invitedAt,
        finalNoticeAt: f.final_notice_at,
        daysSinceInvite: r.invitedAt ? Math.floor((now - Date.parse(r.invitedAt)) / 86_400_000) : null,
        synced: r.synced,
        billingStaged: r.billingStaged,
        billingApplicable: r.billingApplicable,
        templateConfirmed: r.templateConfirmed,
        recipients,
        deliverability: state,
        deliverabilityDetail: detail,
        hold: !!f.force_hold,
        holdReason: f.force_hold_reason,
        forcedAt: f.forced_at,
        verdict: decision.verdict,
        reasons: decision.reasons,
      };
      return row;
    }));
    out.push(...results);
  }

  // Safe first (the actionable ones), then by how long they've been stalled.
  // Recently-forced rows first — they read as EXCLUDED ("already migrated") and
  // would otherwise sink to the bottom, but they are the rows an operator is
  // most likely to have come here to undo. Then actionable-first by verdict,
  // then longest-stalled first.
  const order: Record<ForceVerdict, number> = { safe: 0, "not-ready": 1, unreachable: 2, held: 3, excluded: 4 };
  out.sort((a, b) =>
    Number(!!b.forcedAt) - Number(!!a.forcedAt)
    || order[a.verdict] - order[b.verdict]
    || (b.daysSinceInvite ?? 0) - (a.daysSinceInvite ?? 0));
  return { rows: out, checkedEmails };
}
