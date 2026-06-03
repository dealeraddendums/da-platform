// Self-serve provisioning helpers (Phase 13 / Marketing OS Phase 5).
//
// Extracted from the Trial-creation paths of POST /api/dealers and POST
// /api/groups so the key-authenticated POST /api/self-serve/signup endpoint can
// create a Trial dealer or group + its admin user without a logged-in operator.
//
// Trial accounts intentionally SKIP da-billing (no recurring template until
// conversion — same rule the operator routes apply via subscriptionDescriptorFor
// returning null for Trial). HubSpot Company + Contact creation goes through the
// existing reliable/standard sync so DA Platform stays the sole HubSpot writer.

import { createAdminSupabaseClient } from "@/lib/db";
import { fireDealerCreateReliable, fireGroupSync, fireProfileSync } from "@/lib/sync-hubspot";
import { sendPasskeyInvite } from "@/lib/migration-invite";

export type Attribution = Record<string, string | null> | null | undefined;

// Strip HTML tags (mirrors sanitizeName in app/api/dealers/route.ts) — the
// dealership/group name is operator-controlled here, but it arrives from a
// public web form, so never trust it raw.
function sanitizeName(name: string): string {
  return name.replace(/<[^>]*>/g, "").trim();
}

/**
 * Insert a Trial dealer and fire the reliable HubSpot Company create
 * (lifecyclestage=Dealer Trial → Marketing OS Phase 5 onboarding workflow).
 * No da-billing. Returns the new dealer's UUID + text dealer_id.
 *
 * The `acquisition` write is defensive: if migration 087 hasn't been applied
 * yet, the column is unknown and the insert is retried without it.
 */
export async function createTrialDealer(input: {
  dealership: string;
  contactName: string;
  email: string;
  phone?: string | null;
  attribution?: Attribution;
}): Promise<{ dealerUuid: string; dealerId: string; internalId: string }> {
  const admin = createAdminSupabaseClient();
  const internalId = Date.now().toString();
  const dealerId = `ss_${internalId}`;

  const payload: Record<string, unknown> = {
    dealer_id: dealerId,
    inventory_dealer_id: dealerId,
    name: sanitizeName(input.dealership),
    internal_id: internalId,
    account_type: "Trial",
    primary_contact: input.contactName.trim(),
    primary_contact_email: input.email.trim().toLowerCase(),
    phone: input.phone || null,
    acquisition: input.attribution ?? null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data, error } = await (admin as any).from("dealers").insert(payload).select("id, dealer_id").single();
  if (error && /acquisition/i.test(error.message)) {
    const { acquisition: _drop, ...withoutAcq } = payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ data, error } = await (admin as any).from("dealers").insert(withoutAcq).select("id, dealer_id").single());
  }
  if (error || !data) {
    throw new Error(`dealer insert failed: ${error?.message ?? "unknown"}`);
  }

  // Reliable HubSpot Company create — the onboarding-workflow trigger. Fire-and-
  // forget (never blocks); retries + alerts on terminal failure internally.
  fireDealerCreateReliable(data.id as string);

  return { dealerUuid: data.id as string, dealerId: data.dealer_id as string, internalId };
}

/**
 * Insert a Trial group and fire the HubSpot Company sync (Group/Reseller Trial).
 * No da-billing, no rooftops — the group_admin adds rooftops in-platform later.
 */
export async function createTrialGroup(input: {
  groupName: string;
  contactName: string;
  email: string;
  phone?: string | null;
  attribution?: Attribution;
}): Promise<{ groupId: string; internalId: string }> {
  const admin = createAdminSupabaseClient();
  const internalId = Date.now().toString();

  const payload: Record<string, unknown> = {
    name: sanitizeName(input.groupName),
    internal_id: internalId,
    account_type: "Trial",
    primary_contact: input.contactName.trim(),
    primary_contact_email: input.email.trim().toLowerCase(),
    phone: input.phone || null,
    acquisition: input.attribution ?? null,
  };

  // Defensive retry strips columns that may not exist yet (acquisition = mig
  // 087; account_type = mig 011, present in prod but kept for parity).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data, error } = await (admin as any).from("groups").insert(payload).select("id").single();
  if (error && /acquisition|account_type/i.test(error.message)) {
    const { acquisition: _a, account_type: _b, ...base } = payload;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ data, error } = await (admin as any).from("groups").insert(base).select("id").single());
  }
  if (error || !data) {
    throw new Error(`group insert failed: ${error?.message ?? "unknown"}`);
  }

  fireGroupSync(data.id as string);

  return { groupId: data.id as string, internalId };
}

/**
 * Create the passwordless admin auth user + profile for a freshly-provisioned
 * dealer/group, sync the Contact to HubSpot, and send the passkey magic-link
 * onboarding invite. Mirrors the createUser → profiles.upsert(id=authUser.id) →
 * fireProfileSync pattern in POST /api/dealers, with the magic link replacing a
 * password. Profile is linked by id; getJwtClaims also has an email fallback.
 */
export async function createAdminUserWithInvite(input: {
  email: string;
  fullName: string;
  phone?: string | null;
  role: "dealer_admin" | "group_admin";
  /** dealer text id (= inventory_dealer_id) for dealer_admin; null for group. */
  dealerTextId?: string | null;
  /** group UUID for group_admin; null for dealer. */
  groupId?: string | null;
  /** Dealer/group name shown in the invite email. */
  entityName: string;
}): Promise<{ userId: string }> {
  const admin = createAdminSupabaseClient();
  const email = input.email.trim().toLowerCase();

  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: input.fullName },
    app_metadata: { role: input.role },
  });
  if (authErr || !authUser?.user) {
    throw new Error(`auth user create failed: ${authErr?.message ?? "unknown"}`);
  }

  const profile: Record<string, unknown> = {
    id: authUser.user.id,
    email,
    full_name: input.fullName,
    phone: input.phone || null,
    role: input.role,
    dealer_id: input.dealerTextId ?? null,
    group_id: input.groupId ?? null,
  };
  const { error: profileErr } = await admin.from("profiles").upsert(profile as never);
  if (profileErr) {
    // Roll back the orphaned auth user so a retry is clean.
    await admin.auth.admin.deleteUser(authUser.user.id).catch(() => {});
    throw new Error(`profile create failed: ${profileErr.message}`);
  }

  // HubSpot Contact sync (plain fire-and-forget — not a workflow trigger).
  fireProfileSync(authUser.user.id);

  // Passkey magic-link onboarding invite (doubles as email verification).
  await sendPasskeyInvite({ email, fullName: input.fullName, entityName: input.entityName });

  return { userId: authUser.user.id };
}

/**
 * Duplicate guard. Returns true if this signup would duplicate an existing
 * account: a profile already exists for the email, OR a dealer/group already
 * exists with the same name. Honors the migration "avoid duplicates" rule.
 */
export async function selfServeDuplicateExists(input: {
  email: string;
  name: string;
  kind: "single" | "group";
}): Promise<boolean> {
  const admin = createAdminSupabaseClient();
  const email = input.email.trim().toLowerCase();
  const name = sanitizeName(input.name);

  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .ilike("email", email)
    .maybeSingle();
  if (profile) return true;

  if (input.kind === "group") {
    const { data: group } = await admin.from("groups").select("id").ilike("name", name).maybeSingle();
    if (group) return true;
  } else {
    const { data: dealer } = await admin.from("dealers").select("id").ilike("name", name).maybeSingle();
    if (dealer) return true;
  }
  return false;
}
