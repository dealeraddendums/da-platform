import type { SupabaseClient } from "@supabase/supabase-js";

// Scope-aware "email already registered" message for the invite routes.
//
// The generic 409 ("contact support…") sent operators hunting for users that
// the Users tab can't show — the Grissom case (2026-08-30): the email backed a
// group_admin on the group OWNING the dealer (full dealer parity, invisible on
// the dealer-scoped Users tab), and the operator read the block as a bug.
// When the existing registration lives INSIDE the caller's target scope (same
// dealer, or a group/member relationship with it), say so — that's the
// operator's own account data. Anything outside the scope stays generic, so
// the endpoint can't be used to probe which dealership an email belongs to.

const ROLE_LABELS: Record<string, string> = {
  dealer_admin: "Dealer Admin",
  dealer_user: "Dealer User",
  dealer_restricted: "Restricted User",
  group_admin: "Group Admin",
  group_user: "Regional Manager",
};

const GENERIC =
  "This email is already registered to another DealerAddendums account. Contact support to add access to multiple dealerships.";

/**
 * Returns a 409 message when the email already has a profile, else null.
 * `target` describes what the caller is inviting INTO:
 *  - dealer invites: dealerTextId + that dealer's groupId (null if ungrouped)
 *  - group invites:  groupId only
 */
export async function duplicateRegistrationMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  email: string,
  target: { dealerTextId?: string | null; groupId?: string | null },
): Promise<string | null> {
  const { data: existing } = await admin
    .from("profiles")
    .select("id, role, dealer_id, group_id, active")
    .ilike("email", email.trim().toLowerCase())
    .maybeSingle<{ id: string; role: string; dealer_id: string | null; group_id: string | null; active: boolean | null }>();
  if (!existing) return null;

  const roleLabel = ROLE_LABELS[existing.role] ?? null;
  const inactive = existing.active === false ? " (currently deactivated)" : "";

  // Same dealer — the account is right there on this dealership.
  if (existing.dealer_id && target.dealerTextId && existing.dealer_id === target.dealerTextId) {
    return roleLabel
      ? `This email already has a ${roleLabel} account on this dealership${inactive} — no new invite needed; they sign in with this email (Users tab → Resend/Set Password if they're stuck).`
      : GENERIC;
  }

  // Group-scoped account on the caller's target group, or on the group that
  // owns the target dealer — group roles already cover the member dealers.
  if (existing.group_id && roleLabel) {
    const matchesGroup =
      existing.group_id === target.groupId /* group invite to the same group */;
    let ownsDealer = false;
    if (!matchesGroup && target.dealerTextId) {
      const { data: d } = await admin
        .from("dealers")
        .select("group_id")
        .eq("dealer_id", target.dealerTextId)
        .maybeSingle<{ group_id: string | null }>();
      ownsDealer = !!d?.group_id && d.group_id === existing.group_id;
    }
    if (matchesGroup || ownsDealer) {
      const { data: g } = await admin
        .from("groups")
        .select("name")
        .eq("id", existing.group_id)
        .maybeSingle<{ name: string }>();
      const gname = g?.name ? `“${g.name}”` : "this group";
      return ownsDealer
        ? `This email is already a ${roleLabel} on the group ${gname}, which includes this dealership${inactive} — they can already manage it by signing in with this email; no invite needed.`
        : `This email is already a ${roleLabel} on ${gname}${inactive} — no new invite needed; they sign in with this email.`;
    }
  }

  // Outside the caller's scope — stay generic (no cross-dealer disclosure).
  return GENERIC;
}
