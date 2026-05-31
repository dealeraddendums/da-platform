// Phase 14a — fire-and-forget HubSpot record sync.
//
// Mirrors lib/billing-sync.ts: every public function returns void
// and never throws. Failures land in `hubspot_sync_errors` with the
// payload for replay. Call sites are the same lifecycle hooks that
// already fire-and-forget to da-billing today (dealer/group/user
// create+update). Cron-driven sync of computed fields (prints_last_30,
// dealers_in_group, Trial → Trial Expired re-eval) is Phase 14b and
// lives in a separate cron route.

import { createAdminSupabaseClient } from "@/lib/db";
import {
  hubspotConfigured,
  upsertObject,
  LIFECYCLE,
  normalizeSubscriptionType,
  isPayingAccount,
} from "@/lib/hubspot";

// ── Property builders ───────────────────────────────────────────────────────

interface DealerForHubspot {
  id: string;
  dealer_id: string;           // text slug — platformid + da_dealer_ both get this
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  inventory_dealer_id: string | number | null;     // dealerid (Aurora numeric)
  billing_customer_id: string | null;
  internal_id: string | null;                      // billingid fallback
  group_id: string | null;
  account_type: string | null;
  sub_billing_to: string | null;
  inventory_provider: string | null;
  inventory_provider_is_dms: boolean | null;
  last30: number | null;
  billing_street: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_to: string | null;
  hubspot_company_id: string | null;
  created_at: string | null;
}

interface GroupForHubspot {
  id: string;
  name: string | null;
  internal_id: string | null;
  hubspot_company_id: string | null;
  billing_customer_id: string | null;
}

interface ProfileForHubspot {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  role: string | null;
  dealer_id: string | null;
  group_id: string | null;
  hubspot_contact_id: string | null;
}

function dealerCompanyProperties(d: DealerForHubspot, groupName: string | null, groupId: string | null): Record<string, string | number | null> {
  const platformId = d.dealer_id;
  const billingId = d.billing_customer_id ?? d.internal_id ?? null;
  const subType = normalizeSubscriptionType(d.account_type);
  const stage = isPayingAccount(d.account_type) ? LIFECYCLE.CUSTOMER : LIFECYCLE.DEALER_TRIAL;

  return {
    // Identity / four-ID block
    name:        d.name,
    dealerid:    d.inventory_dealer_id != null ? String(d.inventory_dealer_id) : null,
    platformid:  platformId,
    da_dealer_:  platformId,                                          // legacy export field — write same value as platformid
    billingid:   billingId,
    groupid:     groupId,                                             // group.internal_id (numeric), not group UUID
    dealer_group: groupName,

    // Address (mailing)
    address: d.address,
    city:    d.city,
    state:   d.state,
    zip:     d.zip,
    country: d.country,

    // Phones — phone is string, dealership_phone is number type in HubSpot
    phone:            d.phone,
    dealership_phone: digitsOnly(d.phone),
    company_email:    d.primary_contact_email,

    // Plan / billing
    subscription_type: subType,
    sub_billing_to:    d.sub_billing_to,

    // Billing contact block — dealers have no separate billing_email /
    // billing_phone columns; fall back to primary contact info.
    billing_contact_mailing_address: d.billing_street,
    billing_contact_city:            d.billing_city,
    billing_contact_state:           d.billing_state,
    billing_contact_zip:             d.billing_zip,
    billing_contact_name:            d.billing_to ?? d.primary_contact,
    billing_contact_email:           d.primary_contact_email,
    billing_contact_phone_number:    d.phone,

    // Inventory feed. Both fields go null together when no provider —
    // emitting Auto-Web on a dealer with no feed was misleading in the
    // portal.
    feed_company:      d.inventory_provider,
    feed_company_type: d.inventory_provider ? (d.inventory_provider_is_dms ? "Auto-DMS" : "Auto-Web") : null,

    // Activity — last30 is event-driven (already on the row); 12mo +
    // dealers_in_group come from the cron in 14b.
    prints_last_30: d.last30 ?? null,

    // Lifecycle — paying ? Customer : Dealer Trial. Trial → Trial Expired
    // transitions are handled by the daily cron in 14b.
    lifecyclestage: stage,
  };
}

function groupCompanyProperties(g: GroupForHubspot, memberCount: number): Record<string, string | number | null> {
  return {
    name: g.name,
    groupid: g.internal_id,                          // numeric internal id
    billingid: g.billing_customer_id ?? null,
    dealers_in_group: memberCount,
    // Group / reseller default to Group Trial on first sync. Operators
    // flip to Customer in HubSpot; we don't push lifecyclestage on
    // updates for groups to avoid stomping the operator's edit.
    lifecyclestage: g.hubspot_company_id ? null : LIFECYCLE.GROUP_TRIAL,
  };
}

function profileContactProperties(p: ProfileForHubspot, companyName: string | null): Record<string, string | null> {
  const [firstname, ...rest] = (p.full_name ?? "").trim().split(/\s+/);
  const lastname = rest.join(" ");
  return {
    email:     p.email,
    firstname: firstname || null,
    lastname:  lastname  || null,
    phone:     p.phone,
    user_type: p.role,
    username:  p.email,                              // login username = email
    user_id:   p.email,                              // both = email per Allan
    dealer_id: p.dealer_id,
    group_id:  p.group_id,
    company:   companyName,
  };
}

function digitsOnly(s: string | null | undefined): number | null {
  if (!s) return null;
  const digits = String(s).replace(/\D+/g, "");
  return digits ? Number(digits) : null;
}

// ── Error logging ───────────────────────────────────────────────────────────

async function logError(
  objectType: "company" | "contact",
  objectId: string,
  op: "create" | "update" | "search",
  err: unknown,
  payload: Record<string, unknown>,
  hubspotId: string | null = null,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[hubspot-sync] ${objectType} ${objectId} ${op} failed:`, message);
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any).from("hubspot_sync_errors").insert({
      object_type: objectType,
      object_id: objectId,
      hubspot_id: hubspotId,
      op,
      error_message: message,
      payload,
    });
  } catch (logErr) {
    console.error("[hubspot-sync] failed to log error:", logErr instanceof Error ? logErr.message : logErr);
  }
}

// ── Public sync functions — all fire-and-forget, never throw ────────────────

/**
 * Upsert a Company in HubSpot for a dealer. Stores the returned hubspot
 * company id back to `dealers.hubspot_company_id` when it changes.
 *
 * Three-stage match: (1) row already has hubspot_company_id → PATCH;
 * (2) search by platformid → PATCH + store id; (3) create.
 */
export async function syncDealerToHubspot(dealerId: string): Promise<void> {
  if (!hubspotConfigured()) return;
  const admin = createAdminSupabaseClient();
  let payload: Record<string, unknown> = {};
  try {
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, dealer_id, name, address, city, state, zip, country, phone, primary_contact, primary_contact_email, inventory_dealer_id, billing_customer_id, internal_id, group_id, account_type, sub_billing_to, inventory_provider, inventory_provider_is_dms, last30, billing_street, billing_city, billing_state, billing_zip, billing_to, hubspot_company_id, created_at")
      .eq("id", dealerId)
      .maybeSingle<DealerForHubspot>();
    if (!dealer) return;

    let groupName: string | null = null;
    let groupNumericId: string | null = null;
    if (dealer.group_id) {
      const { data: g } = await admin
        .from("groups")
        .select("name, internal_id")
        .eq("id", dealer.group_id)
        .maybeSingle<{ name: string | null; internal_id: string | null }>();
      groupName = g?.name ?? null;
      groupNumericId = g?.internal_id ?? null;
    }

    const properties = dealerCompanyProperties(dealer, groupName, groupNumericId);
    payload = properties;

    const { hubspotId, created } = await upsertObject({
      object: "companies",
      properties,
      existingHubspotId: dealer.hubspot_company_id,
      searchProperty: "platformid",
      searchValue: dealer.dealer_id,
    });

    if (created || hubspotId !== dealer.hubspot_company_id) {
      await admin.from("dealers").update({ hubspot_company_id: hubspotId }).eq("id", dealerId);
    }
  } catch (err) {
    void logError("company", dealerId, "update", err, payload);
  }
}

export async function syncGroupToHubspot(groupId: string): Promise<void> {
  if (!hubspotConfigured()) return;
  const admin = createAdminSupabaseClient();
  let payload: Record<string, unknown> = {};
  try {
    const { data: group } = await admin
      .from("groups")
      .select("id, name, internal_id, hubspot_company_id, billing_customer_id")
      .eq("id", groupId)
      .maybeSingle<GroupForHubspot>();
    if (!group) return;

    const { count: memberCount } = await admin
      .from("dealers")
      .select("id", { count: "exact", head: true })
      .eq("group_id", groupId)
      .eq("active", true);

    const properties = groupCompanyProperties(group, memberCount ?? 0);
    payload = properties;

    const { hubspotId, created } = await upsertObject({
      object: "companies",
      properties,
      existingHubspotId: group.hubspot_company_id,
      searchProperty: "groupid",
      searchValue: group.internal_id,
    });

    if (created || hubspotId !== group.hubspot_company_id) {
      await admin.from("groups").update({ hubspot_company_id: hubspotId }).eq("id", groupId);
    }
  } catch (err) {
    void logError("company", groupId, "update", err, payload);
  }
}

export async function syncProfileToHubspot(profileId: string): Promise<void> {
  if (!hubspotConfigured()) return;
  const admin = createAdminSupabaseClient();
  let payload: Record<string, unknown> = {};
  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("id, email, full_name, phone, role, dealer_id, group_id, hubspot_contact_id")
      .eq("id", profileId)
      .maybeSingle<ProfileForHubspot>();
    if (!profile) return;

    let companyName: string | null = null;
    if (profile.dealer_id) {
      const { data: d } = await admin
        .from("dealers")
        .select("name")
        .eq("dealer_id", profile.dealer_id)
        .maybeSingle<{ name: string | null }>();
      companyName = d?.name ?? null;
    }

    const properties = profileContactProperties(profile, companyName);
    payload = properties;

    const { hubspotId, created } = await upsertObject({
      object: "contacts",
      properties,
      existingHubspotId: profile.hubspot_contact_id,
      searchProperty: "email",
      searchValue: profile.email,
    });

    if (created || hubspotId !== profile.hubspot_contact_id) {
      await admin.from("profiles").update({ hubspot_contact_id: hubspotId }).eq("id", profileId);
    }
  } catch (err) {
    void logError("contact", profileId, "update", err, payload);
  }
}

// ── Fire-and-forget convenience wrappers (call from route handlers) ─────────

export function fireDealerSync(dealerId: string): void { void syncDealerToHubspot(dealerId); }
export function fireGroupSync(groupId: string): void  { void syncGroupToHubspot(groupId); }
export function fireProfileSync(profileId: string): void { void syncProfileToHubspot(profileId); }
