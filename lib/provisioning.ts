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
import { syncDealerCreateReliable, syncGroupToHubspot, fireProfileSync } from "@/lib/sync-hubspot";
import { SOURCE_FORM } from "@/lib/hubspot";
import { sendPasskeyInvite } from "@/lib/migration-invite";
import { sendMandrillEmail } from "@/lib/mandrill";

const SUPPORT_EMAIL = process.env.SUPPORT_NOTIFICATION_EMAIL ?? "support@dealeraddendums.com";

/** Fire-and-forget staff notification — swallows errors so it never blocks the main flow. */
function notifySupport(subject: string, html: string): void {
  sendMandrillEmail({
    subject,
    html,
    from_email: "noreply@dealeraddendums.com",
    from_name: "DA Platform",
    to: [{ email: SUPPORT_EMAIL, name: "DA Support" }],
  }).catch(err => console.error("[notify-support]", err instanceof Error ? err.message : err));
}

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
  zip?: string | null;
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
    zip: input.zip || null,
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

  // Reliable HubSpot Company create — the onboarding-workflow trigger. Stamps
  // source_form="DA Mktg OS" + industry="Automotive Dealer" on create (create-
  // only; never clobbers later operator edits). AWAITED here (not fire-and-
  // forget) so the Company + its hubspot_company_id exist before the caller
  // syncs the admin Contact, letting that sync associate Contact↔Company.
  await syncDealerCreateReliable(data.id as string, SOURCE_FORM.SELF_SERVE);

  // Seed sample data so the fresh standalone trial isn't an empty account.
  // Self-guarded (Trial + group_id NULL + not-yet-seeded) and never throws.
  await seedTrialSampleData(data.dealer_id as string);

  // Staff notification — fire-and-forget.
  notifySupport(
    `New Trial Signup: ${input.dealership}`,
    `<p><strong>New trial account created on DA Platform.</strong></p>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealership</td><td><strong>${input.dealership}</strong></td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Contact</td><td>${input.contactName} &lt;${input.email}&gt;</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Phone</td><td>${input.phone ?? "—"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Zip</td><td>${input.zip ?? "—"}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Dealer ID</td><td>${data.dealer_id as string}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666">Signed up</td><td>${new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT</td></tr>
</table>`,
  );

  return { dealerUuid: data.id as string, dealerId: data.dealer_id as string, internalId };
}

/**
 * Seed one sample Required product + one New + one Used sample vehicle for a
 * brand-new STANDALONE Trial dealer, so a fresh signup lands on a non-empty
 * account. Scope + idempotency are enforced here so it's safe to call from any
 * creation path (self-serve `createTrialDealer` and the admin POST /api/dealers
 * standalone-trial branch):
 *   - only `account_type='Trial'` AND `group_id IS NULL` (group/reseller members
 *     are operated by the group, which adds real inventory — skipped);
 *   - seeded exactly once, claimed via `dealers.sample_seeded_at` (migration 093)
 *     with an `.is(null)` guard so re-runs/re-saves never duplicate and deleting
 *     a sample never re-seeds it.
 * All records are clearly samples (`(Sample Product)` description; `SAMPLE-NEW`/
 * `SAMPLE-USED` stock numbers) and are ordinary rows the dealer can edit/delete.
 * Never throws — a seed failure must not break dealer creation.
 */
export async function seedTrialSampleData(dealerId: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  try {
    // Scope guard. Selecting sample_seeded_at also no-ops gracefully if migration
    // 093 hasn't been applied yet (the select errors → we return without seeding).
    // `as any`: the generated DB types don't include the new column yet (mirrors
    // the acquisition-column casts above).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealer, error } = await (admin as any)
      .from("dealers")
      .select("account_type, group_id, sample_seeded_at")
      .eq("dealer_id", dealerId)
      .single();
    if (error || !dealer) return;
    if (dealer.account_type !== "Trial" || dealer.group_id != null || dealer.sample_seeded_at != null) return;

    // Claim the one-time slot first: only the caller that flips NULL→now() seeds,
    // so concurrent/retried creates can't duplicate the records.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: claimed } = await (admin as any)
      .from("dealers")
      .update({ sample_seeded_at: new Date().toISOString() })
      .eq("dealer_id", dealerId)
      .is("sample_seeded_at", null)
      .select("dealer_id")
      .single();
    if (!claimed) return;

    // 1. Sample Required product (Configure Product / addendum_library).
    //    Required + applies_to 'all' + ad_types New/Used → auto-applies to both
    //    sample vehicles, so printing either renders a complete addendum.
    const { error: prodErr } = await admin.from("addendum_library").insert({
      dealer_id: dealerId,
      option_name: "Ceramic Tint",
      item_price: "599",
      description:
        "(Sample Product) This advanced coating offers enhanced durability and longevity compared to standard tint, protecting your vehicle's interior and improving driving comfort.",
      ad_type: "Both",
      ad_types: ["New", "Used"],
      applies_to: "all",
      required: true,
      active: true,
      makes: "", makes_not: false,
      models: "", models_not: false,
      trims: "", trims_not: false,
      body_styles: "",
      year_condition: 0, year_value: null,
      miles_condition: 0, miles_value: null,
      msrp_condition: 0, msrp1: null, msrp2: null,
      sort_order: 10,
      show_models_only: false,
      separator_above: false, separator_below: false,
      spaces: 0,
    });
    if (prodErr) console.error("[sample-seed] product insert failed for", dealerId, prodErr.message);

    // 2. Sample vehicles. Upsert on the (dealer_id, stock_number) unique key with
    //    ignoreDuplicates so a partial retry can't error or double-insert.
    const { error: vehErr } = await admin
      .from("dealer_vehicles")
      .upsert(
        [
          {
            dealer_id: dealerId,
            stock_number: "SAMPLE-NEW",
            vin: "JTEABFAJ6VK069985",
            year: 2027,
            make: "Toyota",
            model: "Land Cruiser",
            trim: null,
            exterior_color: "Meteor Shower",
            interior_color: "Tan",
            engine: "Hybrid",
            transmission: "8-Speed Electronic",
            fuel: "Hybrid",
            drivetrain: "4WD",
            msrp: 70477,
            cmpg: "22",
            hmpg: "25",
            mileage: 8,
            condition: "New",
            status: "active",
            decode_source: "manual",
          },
          {
            dealer_id: dealerId,
            stock_number: "SAMPLE-USED",
            vin: "1GNEVJKW9LJ274964",
            year: 2020,
            make: "Chevrolet",
            model: "Traverse",
            trim: "RS",
            exterior_color: "Black Metallic",
            interior_color: "Jet Black",
            engine: "3.6L V6",
            transmission: "9-Speed Automatic",
            fuel: "Gas",
            drivetrain: "AWD",
            msrp: 23218,
            cmpg: "17",
            hmpg: "25",
            mileage: 48512,
            condition: "Used",
            status: "active",
            decode_source: "manual",
          },
        ] as never,
        { onConflict: "dealer_id,stock_number", ignoreDuplicates: true },
      );
    if (vehErr) console.error("[sample-seed] vehicle insert failed for", dealerId, vehErr.message);
  } catch (e) {
    console.error("[sample-seed] failed for", dealerId, e instanceof Error ? e.message : e);
  }
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
  zip?: string | null;
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
    zip: input.zip || null,
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

  // Awaited (not fire-and-forget) for the same reason as the dealer path: the
  // group Company + its hubspot_company_id must exist before the caller syncs
  // the group_admin Contact so that sync can associate them. Stamps
  // source_form="DA Mktg OS" + industry on create (create-only).
  await syncGroupToHubspot(data.id as string, { sourceForm: SOURCE_FORM.SELF_SERVE });

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
  // onConflict:"id" is REQUIRED — the handle_new_user trigger already inserted a
  // minimal profile row (role defaulting to 'dealer_user') on the createUser
  // above with ON CONFLICT DO NOTHING. Without an explicit id conflict target the
  // role never updates and the admin is stuck as dealer_user (can't manage
  // billing). Codebase permanent rule: always upsert profiles with onConflict id.
  const { error: profileErr } = await admin.from("profiles").upsert(profile as never, { onConflict: "id" });
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
