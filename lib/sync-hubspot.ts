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
import { sendMandrillEmail } from "@/lib/mandrill";
import {
  COMPANY_TYPE,
  DedupSkipError,
  HubspotError,
  INDUSTRY,
  LIFECYCLE,
  archiveObject,
  associateContactToCompany,
  hubspotConfigured,
  isPayingAccount,
  normalizeSubscriptionType,
  upsertObject,
} from "@/lib/hubspot";
import { isOverAllowance, isFreeAccountType, hasActiveTrialOverride } from "@/lib/print-eligibility";
import { printedVehicleCount } from "@/lib/print-counts";

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
  feed_authorized_name: string | null;
  feed_authorized_email: string | null;
  last30: number | null;
  billing_street: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
  billing_to: string | null;
  hubspot_company_id: string | null;
  hubspot_primary_contact_id: string | null; // migration 143 — primary-contact Contact
  created_at: string | null;
  downgraded_at: string | null;          // set on paying→Free, cleared on re-upgrade
  trial_ends_at: string | null;          // migration 126 — extend-trial override
  trial_prints_cap: number | null;       // migration 126 — extend-trial override
}

interface GroupForHubspot {
  id: string;
  name: string | null;
  internal_id: string | null;
  hubspot_company_id: string | null;
  billing_customer_id: string | null;
  phone: string | null;
  zip: string | null;
  primary_contact: string | null;
  primary_contact_email: string | null;
  billing_contact: string | null;
  billing_email: string | null;
  billing_phone: string | null;
  billing_address: string | null;
  billing_city: string | null;
  billing_state: string | null;
  billing_zip: string | null;
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
  active: boolean | null;
}

function dealerCompanyProperties(d: DealerForHubspot, groupName: string | null, groupId: string | null, lifetimePrints: number): Record<string, string | number | null> {
  const platformId = d.dealer_id;
  const billingId = d.billing_customer_id ?? d.internal_id ?? null;
  const subType = normalizeSubscriptionType(d.account_type);
  // Four-way lifecycle derivation (precedence from docs/print-eligibility-free-expired.md):
  //   1. paying account                          → CUSTOMER
  //   2. downgraded_at set OR account_type=Free  → ACCOUNT_DOWNGRADED
  //         (paying→Free transition OR a directly-Free row carries no
  //          downgraded_at if it was never a paid account — both go to
  //          the same stage)
  //   3. trial (over allowance: >30 days OR >30 lifetime prints) → TRIAL_EXPIRED
  //   4. trial within allowance                  → DEALER_TRIAL
  //
  // The same isOverAllowance predicate gates server-side printing in
  // lib/print-eligibility.ts. Sharing it here means the dealer-side
  // canPrint and the HubSpot lifecyclestage never disagree about who's
  // expired.
  //
  // The nightly cron at /api/cron/sync-hubspot-computed re-evaluates
  // Trial → Trial Expired daily even when nothing event-driven fires.
  let stage: string;
  if (isPayingAccount(d.account_type)) {
    stage = LIFECYCLE.CUSTOMER;
  } else if (hasActiveTrialOverride(d)) {
    // Operator-extended trial (migration 126) outranks the Free/Downgraded
    // bucket — mirrors canPrint, where an active override grants trial-track
    // printing even to a Free/legacy dealer. Prints axis can still expire it.
    stage = isOverAllowance({ created_at: d.created_at, lifetime_prints: lifetimePrints, trial_ends_at: d.trial_ends_at, trial_prints_cap: d.trial_prints_cap })
      ? LIFECYCLE.TRIAL_EXPIRED
      : LIFECYCLE.DEALER_TRIAL;
  } else if (d.downgraded_at || isFreeAccountType(d.account_type)) {
    stage = LIFECYCLE.ACCOUNT_DOWNGRADED;
  } else if (isOverAllowance({ created_at: d.created_at, lifetime_prints: lifetimePrints, trial_ends_at: d.trial_ends_at, trial_prints_cap: d.trial_prints_cap })) {
    stage = LIFECYCLE.TRIAL_EXPIRED;
  } else {
    stage = LIFECYCLE.DEALER_TRIAL;
  }

  return {
    // Identity / four-ID block
    name:        d.name,
    // dealerid is a string/text property in HubSpot (verified via the
    // properties API 2026-07-25 — an earlier comment called it Number-type,
    // and the old /^\d+$/ guard silently dropped legitimate TEXT feed ids
    // like "bussfordlincoln" / "mp23083" / "KiaTemecula"). Skip only "ss_…"
    // placeholders — a self-serve dealer's provisional id isn't a real
    // inventory id and shouldn't overwrite/announce itself in HubSpot.
    dealerid:    (d.inventory_dealer_id != null && String(d.inventory_dealer_id).trim() !== "" && !/^ss_/i.test(String(d.inventory_dealer_id))) ? String(d.inventory_dealer_id).trim() : null,
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
    // Dealership contact authorized to approve feed/DMS setup (collected at
    // subscription). Map to HubSpot custom company props feed_contact_name /
    // feed_contact_email — if not yet created in the portal, the sync logs to
    // hubspot_sync_errors but the subscription change still completes.
    feed_contact_name:  d.feed_authorized_name,
    feed_contact_email: d.feed_authorized_email,

    // Activity — dealers.last30 is refreshed nightly by the computed cron
    // (distinct vehicles from print_history, rolling 30 days); 12mo +
    // dealers_in_group come from the cron too.
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
    platformid: g.id,                                // group Supabase UUID (dealers use dealer_id here)
    // internal_id fallback mirrors the dealer builder — da-billing matches
    // customers on internal_id, so it's the billing key before a da-billing
    // customer exists (self-serve trial groups have none until conversion).
    billingid: g.billing_customer_id ?? g.internal_id ?? null,
    dealers_in_group: memberCount,
    phone: g.phone,
    zip: g.zip,
    company_email: g.primary_contact_email,

    // Billing contact block — self-serve group signups store the form's
    // Full Name / Work Email / Phone / Zip on the group's primary_* columns;
    // dedicated billing_* columns (set later by operators) win when present.
    billing_contact_name:            g.billing_contact ?? g.primary_contact,
    billing_contact_email:           g.billing_email ?? g.primary_contact_email,
    billing_contact_phone_number:    g.billing_phone ?? g.phone,
    billing_contact_zip:             g.billing_zip ?? g.zip,
    billing_contact_mailing_address: g.billing_address,
    billing_contact_city:            g.billing_city,
    billing_contact_state:           g.billing_state,
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
    // "DA User" contact property — every contact this sync touches is a DA
    // login account; active-aware so a deactivation flips it back. NOTE: the
    // HubSpot enum's internal values are "true"/"false" ("Yes"/"No" are only
    // the display labels — confirmed via GET /crm/v3/properties/contacts/da_user).
    da_user:   p.active === false ? "false" : "true",
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
  op: "create" | "update" | "search" | "dedup-skip",
  err: unknown,
  payload: Record<string, unknown>,
  hubspotId: string | null = null,
): Promise<void> {
  // Include the HubSpot response body when available — the raw body has the
  // specific property/validation error that caused the 400, which err.message
  // alone ("create companies 400") doesn't capture.
  const message = err instanceof HubspotError && err.body
    ? `${err.message} — ${err.body.slice(0, 800)}`
    : err instanceof Error ? err.message : String(err);
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

/**
 * Operator alert fired the first time the dedup guard refuses a create
 * for a given Supabase object. Mandrill same as the reliable-sync
 * failure alert — support@ needs to manually merge the unlinked
 * original in HubSpot, then re-run the sync (which now matches by
 * platformid/groupid).
 */
async function alertDedupSkip(args: {
  objectKind: "dealer" | "group";
  supabaseId: string;
  identityLabel: string;        // dealer slug / group internal_id — human-readable handle
  unlinkedOriginalId: string;
  matchedOn: string;
}): Promise<void> {
  try {
    const portalUrl = `https://app.hubspot.com/contacts/23896347/record/0-2/${args.unlinkedOriginalId}`;
    await sendMandrillEmail({
      subject: `[HubSpot dedup] refused to duplicate ${args.objectKind} ${args.identityLabel}`,
      from_email: "alerts@dealeraddendums.com",
      from_name: "DA Platform Alerts",
      to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
      html: `<p>HubSpot sync for <b>${args.objectKind} ${args.identityLabel}</b> was about to create a duplicate Company.</p>
<p>Found an unlinked match on <code>${args.matchedOn}</code> — HubSpot id <a href="${portalUrl}">${args.unlinkedOriginalId}</a>.</p>
<p>The sync did <b>not</b> create a new record. To resolve:</p>
<ol>
  <li>Open the linked record and confirm it's the correct dealer/group.</li>
  <li>Either (a) stamp <code>${args.objectKind === "dealer" ? "platformid" : "groupid"}</code> on that record manually and re-run the sync, or (b) run <code>scripts/hubspot-dedup.mjs --apply</code> to merge any sync-created stub into this record.</li>
</ol>
<p>Supabase id: <code>${args.supabaseId}</code>.</p>`,
    });
  } catch (err) {
    console.error("[hubspot-sync] dedup alert send failed:", err instanceof Error ? err.message : err);
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
/**
 * Upsert the HubSpot CONTACT for a dealer's PRIMARY CONTACT and associate it
 * to the dealer's Company (2026-08-14). Runs on every dealer sync (create,
 * edit, trial, migrate — all paths funnel through syncDealerToHubspot), so
 * the CRM always has a reachable person, not just the Company. Previously
 * Contacts were minted only at /api/invite/accept.
 *
 * Matching is ALWAYS by email (existingHubspotId: null), never by the stored
 * id: a primary contact is often SHARED across a group's dealers (the
 * AutoNation pattern — one person on many rooftops), and the contact-edit
 * path swaps PEOPLE — a PATCH-by-stored-id would rewrite the shared
 * Contact's email/name and corrupt every other dealer's contact. Adopt
 * semantics: name/phone/company ride as createOnlyProperties, so adopting an
 * existing Contact (e.g. one minted by invite-accept, which owns richer
 * profile data) never clobbers it; only a brand-new Contact is fully
 * populated. The association is HubSpot's v4 DEFAULT contact↔company
 * association, keyed on (contact id, company id, default type) — a PUT is
 * idempotent, so re-syncs and shared contacts across many companies never
 * duplicate associations, they just add the one company link if missing.
 *
 * Failures log to hubspot_sync_errors (objectType "contact") and never block
 * or mask the company sync.
 */
export async function syncDealerPrimaryContact(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealer: DealerForHubspot,
  companyHubspotId: string,
): Promise<{ contactId: string; created: boolean } | { skipped: "no-email" } | { failed: true }> {
  const email = (dealer.primary_contact_email ?? "").trim().toLowerCase();
  // No email → nothing to match or create; company sync is unaffected.
  if (!email || !email.includes("@")) return { skipped: "no-email" };

  const fullName = (dealer.primary_contact ?? "").trim();
  const [firstname, ...rest] = fullName.split(/\s+/);
  const lastname = rest.join(" ");

  const payload: Record<string, unknown> = { email, firstname, lastname, dealer: dealer.dealer_id };
  let contactId: string | null = null;
  try {
    const { hubspotId, created } = await upsertObject({
      object: "contacts",
      // Always-applied props: identity only (email is the search key, so this
      // is a no-op on adopts). Person details are create-only — see above.
      properties: { email },
      createOnlyProperties: {
        firstname: firstname || null,
        lastname: lastname || null,
        phone: dealer.phone,
        company: dealer.name,
      },
      existingHubspotId: null, // deliberate — match by email, never stored id
      searchProperty: "email",
      searchValue: email,
    });
    contactId = hubspotId;

    if (hubspotId !== dealer.hubspot_primary_contact_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("dealers").update({ hubspot_primary_contact_id: hubspotId }).eq("id", dealer.id);
    }

    await associateContactToCompany(hubspotId, companyHubspotId);
    return { contactId: hubspotId, created };
  } catch (err) {
    void logError("contact", dealer.id, "update", err, { ...payload, association: contactId ? `contact ${contactId} -> company ${companyHubspotId}` : null }, contactId);
    return { failed: true };
  }
}

/**
 * Is this dealer a REAL account (as opposed to Test / Sales Demo)?
 *
 * The Account Purpose UI promises Test & Sales Demo dealers are "excluded from
 * BI/billing/HubSpot". BI and billing honoured that via the derived
 * `is_test` flag; HubSpot did not — every test/sales-demo dealer minted a real
 * CRM Company (and Contact) and only got cleaned up on delete. This is the
 * gate that makes the HubSpot half of the promise true.
 *
 * Reads `account_purpose` with `is_test` as the fallback, because
 * account_purpose was added later and older rows may only carry is_test. The
 * server keeps them consistent (is_test = account_purpose <> 'real') on both
 * the create and PATCH paths.
 *
 * Returns true when the dealer cannot be found, so a lookup failure never
 * silently suppresses a legitimate sync.
 */
export async function isRealAccountDealer(dealerId: string): Promise<boolean> {
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (admin as any)
      .from("dealers")
      .select("account_purpose, is_test")
      .eq("id", dealerId)
      .maybeSingle() as { data: { account_purpose?: string | null; is_test?: boolean | null } | null };
    if (!data) return true;
    if (data.account_purpose != null) return data.account_purpose === "real";
    return data.is_test !== true;
  } catch {
    return true;
  }
}

export async function syncDealerToHubspot(dealerId: string, opts?: { sourceForm?: string | null }): Promise<void> {
  if (!hubspotConfigured()) return;
  const admin = createAdminSupabaseClient();
  let payload: Record<string, unknown> = {};
  try {
    // `as any` on the chain because migration 083 (downgraded_at) is
    // applied at runtime but Supabase's generated types don't know
    // about it yet. The DealerForHubspot interface is the contract.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealer } = await (admin as any)
      .from("dealers")
      .select("id, dealer_id, name, address, city, state, zip, country, phone, primary_contact, primary_contact_email, inventory_dealer_id, billing_customer_id, internal_id, group_id, account_type, sub_billing_to, inventory_provider, inventory_provider_is_dms, feed_authorized_name, feed_authorized_email, last30, billing_street, billing_city, billing_state, billing_zip, billing_to, hubspot_company_id, hubspot_primary_contact_id, created_at, downgraded_at, trial_ends_at, trial_prints_cap, account_purpose, is_test")
      .eq("id", dealerId)
      .maybeSingle() as { data: DealerForHubspot | null };
    if (!dealer) return;

    // Defensive guard: never create/patch a HubSpot Company for a nameless
    // dealer (would produce a blank "--" record). No such dealers exist today,
    // but this keeps the create path safe if one ever appears.
    if (!dealer.name || dealer.name.trim() === "") {
      console.warn(`[sync-hubspot] skipping dealer ${dealer.id} — no name`);
      return;
    }

    // Account Purpose gate: Test / Sales Demo dealers never reach the CRM.
    // This is the single choke point — every dealer HubSpot write (create,
    // edit, id-change, extend-trial, and the reliable retry path) funnels
    // through this function, so gating here covers all of them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const purpose = (dealer as any).account_purpose as string | null | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isTest = (dealer as any).is_test as boolean | null | undefined;
    const real = purpose != null ? purpose === "real" : isTest !== true;
    if (!real) {
      console.log(`[sync-hubspot] skipping dealer ${dealer.id} (${dealer.name}) — account_purpose=${purpose ?? (isTest ? "test (via is_test)" : "unknown")}; Test/Sales Demo are excluded from HubSpot`);
      return;
    }

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

    // Lifetime print count (DISTINCT vehicles, not print_history rows — same
    // semantics as the canPrint trial cap) — feeds the Trial Expired
    // derivation alongside created_at. dealers.lifetime_prints isn't a
    // stored column (getPrintCounts in app/api/dealers/route.ts computes
    // it on demand from print_history), so we count it here too. Only
    // matters when the dealer isn't paid and isn't already Free — paid
    // wins outright via isPayingAccount, so this is bounded to legacy
    // trials and ex-trials.
    const lifetimePrints = await printedVehicleCount(admin, { dealerId: dealer.dealer_id });

    const properties = dealerCompanyProperties(dealer, groupName, groupNumericId, lifetimePrints);
    payload = properties;

    // Create-only: a dealer Company is always industry "Automotive Dealer"; the
    // source_form (creation-path attribution) is whatever the caller passed.
    // `type` is the constrained dropdown — "Dealership" (NOT the industry label,
    // which 400s). All applied only when this sync POSTs a new Company — never on
    // a PATCH — so they never clobber a later operator edit.
    const createOnlyProperties: Record<string, string | null> = { industry: INDUSTRY.DEALER, type: COMPANY_TYPE.DEALER };
    if (opts?.sourceForm) createOnlyProperties.source_form = opts.sourceForm;

    const { hubspotId, created } = await upsertObject({
      object: "companies",
      properties,
      createOnlyProperties,
      existingHubspotId: dealer.hubspot_company_id,
      searchProperty: "platformid",
      searchValue: dealer.dealer_id,
      // Adopt + heal an orphaned early-import original (same name, no platformid)
      // instead of creating a duplicate — the PATCH sets platformid so future
      // runs match by key. (Replaces the old findUnlinkedOriginal skip-and-alert,
      // which left such dealers unlinked and let the backfill create dups.)
      dedupByName: dealer.name,
    });

    if (created || hubspotId !== dealer.hubspot_company_id) {
      await admin.from("dealers").update({ hubspot_company_id: hubspotId }).eq("id", dealerId);
    }

    // Primary-contact Contact upsert + company association (2026-08-14) —
    // own try/catch + error row so a contact hiccup never masks a company
    // sync success. Uses the company id from THIS upsert (freshest).
    await syncDealerPrimaryContact(admin, dealer, hubspotId);
  } catch (err) {
    if (err instanceof DedupSkipError) {
      void logError("company", dealerId, "dedup-skip", err, { ...payload, unlinkedOriginalId: err.unlinkedOriginalId, matchedOn: err.matchedOn }, err.unlinkedOriginalId);
      void alertDedupSkip({
        objectKind: "dealer",
        supabaseId: dealerId,
        identityLabel: String(payload.platformid ?? payload.name ?? dealerId),
        unlinkedOriginalId: err.unlinkedOriginalId,
        matchedOn: err.matchedOn,
      });
      return;
    }
    void logError("company", dealerId, "update", err, payload);
  }
}

export async function syncGroupToHubspot(groupId: string, opts?: { sourceForm?: string | null }): Promise<void> {
  if (!hubspotConfigured()) return;
  const admin = createAdminSupabaseClient();
  let payload: Record<string, unknown> = {};
  try {
    const { data: group } = await admin
      .from("groups")
      .select("id, name, internal_id, hubspot_company_id, billing_customer_id, phone, zip, primary_contact, primary_contact_email, billing_contact, billing_email, billing_phone, billing_address, billing_city, billing_state, billing_zip")
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

    // Create-only: groups map to "Automotive Dealer Group" (reseller groups
    // would use INDUSTRY.RESELLER once the data models that distinction — there
    // is no reseller flag on groups today). source_form per creation path.
    // `type` is the constrained dropdown — "Dealer Group" (NOT the industry
    // label). Applied on POST only, never on PATCH.
    const createOnlyProperties: Record<string, string | null> = { industry: INDUSTRY.GROUP, type: COMPANY_TYPE.GROUP };
    if (opts?.sourceForm) createOnlyProperties.source_form = opts.sourceForm;

    const { hubspotId, created } = await upsertObject({
      object: "companies",
      properties,
      createOnlyProperties,
      existingHubspotId: group.hubspot_company_id,
      searchProperty: "groupid",
      searchValue: group.internal_id,
      // Adopt + heal an orphaned same-name original lacking groupid, instead of
      // creating a duplicate (sets groupid via the PATCH). See dealer path above.
      dedupByName: group.name ?? undefined,
    });

    if (created || hubspotId !== group.hubspot_company_id) {
      await admin.from("groups").update({ hubspot_company_id: hubspotId }).eq("id", groupId);
    }
  } catch (err) {
    if (err instanceof DedupSkipError) {
      void logError("company", groupId, "dedup-skip", err, { ...payload, unlinkedOriginalId: err.unlinkedOriginalId, matchedOn: err.matchedOn }, err.unlinkedOriginalId);
      void alertDedupSkip({
        objectKind: "group",
        supabaseId: groupId,
        identityLabel: String(payload.groupid ?? payload.name ?? groupId),
        unlinkedOriginalId: err.unlinkedOriginalId,
        matchedOn: err.matchedOn,
      });
      return;
    }
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
      .select("id, email, full_name, phone, role, dealer_id, group_id, hubspot_contact_id, active")
      .eq("id", profileId)
      .maybeSingle<ProfileForHubspot>();
    if (!profile) return;

    // Account Purpose gate for CONTACTS: a user belonging to a Test / Sales
    // Demo dealer must not create a HubSpot Contact either. Resolved via the
    // profile's text dealer_id (profiles.dealer_id is the dealers.dealer_id
    // text key, not the UUID).
    if (profile.dealer_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: owner } = await (admin as any)
        .from("dealers")
        .select("id, name, account_purpose, is_test")
        .eq("dealer_id", profile.dealer_id)
        .maybeSingle() as { data: { id: string; name: string | null; account_purpose?: string | null; is_test?: boolean | null } | null };
      if (owner) {
        const ownerReal = owner.account_purpose != null ? owner.account_purpose === "real" : owner.is_test !== true;
        if (!ownerReal) {
          console.log(`[sync-hubspot] skipping profile ${profile.id} (${profile.email}) — dealer ${owner.name ?? profile.dealer_id} is Test/Sales Demo, excluded from HubSpot`);
          return;
        }
      }
    }

    // Resolve the Company this contact belongs under (dealer by text id, else
    // group by uuid): its name for the `company` text property, plus uuid +
    // stored HubSpot id for the contact↔company association below.
    let companyName: string | null = null;
    let companyUuid: string | null = null;
    let companyHubspotId: string | null = null;
    let companyKind: "dealer" | "group" | null = null;
    if (profile.dealer_id) {
      const { data: d } = await admin
        .from("dealers")
        .select("id, name, hubspot_company_id")
        .eq("dealer_id", profile.dealer_id)
        .maybeSingle<{ id: string; name: string | null; hubspot_company_id: string | null }>();
      if (d) { companyName = d.name; companyUuid = d.id; companyHubspotId = d.hubspot_company_id; companyKind = "dealer"; }
    } else if (profile.group_id) {
      const { data: g } = await admin
        .from("groups")
        .select("id, name, hubspot_company_id")
        .eq("id", profile.group_id)
        .maybeSingle<{ id: string; name: string | null; hubspot_company_id: string | null }>();
      if (g) { companyName = g.name; companyUuid = g.id; companyHubspotId = g.hubspot_company_id; companyKind = "group"; }
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

    // Associate the Contact to its Company so a dealer's people always appear
    // under the dealership/group in HubSpot (and vice-versa). Idempotent. If the
    // Company hasn't synced yet (create race on a fresh signup), sync it now so
    // the id exists, then associate.
    if (companyUuid && companyKind) {
      if (!companyHubspotId) {
        if (companyKind === "dealer") await syncDealerToHubspot(companyUuid);
        else await syncGroupToHubspot(companyUuid);
        const { data: refreshed } = await admin
          .from(companyKind === "dealer" ? "dealers" : "groups")
          .select("hubspot_company_id")
          .eq("id", companyUuid)
          .maybeSingle<{ hubspot_company_id: string | null }>();
        companyHubspotId = refreshed?.hubspot_company_id ?? null;
      }
      if (companyHubspotId) {
        try {
          await associateContactToCompany(hubspotId, companyHubspotId);
        } catch (assocErr) {
          void logError("contact", profileId, "update", assocErr, { ...payload, association: `contact ${hubspotId} -> company ${companyHubspotId}` }, hubspotId);
        }
      }
    }
  } catch (err) {
    void logError("contact", profileId, "update", err, payload);
  }
}

// ── Reliable dealer sync (retry + Mandrill alert) ───────────────────────────
//
// Two HubSpot Company properties — `subscription_type` and
// `lifecyclestage` — are the fields Alex's workflows enroll off. A
// silent fire-and-forget miss means a workflow never fires, so any
// edit that moves either property has to reach HubSpot promptly and
// reliably. The reliability bar is the same as the dealer-create
// trigger (Marketing OS Phase 5 onboarding workflow): retry 3× with
// short exponential backoff (500ms / 1.5s / 4s), terminal failure
// alerts support@ via Mandrill alongside the usual hubspot_sync_errors
// row, and the route's HTTP response is never blocked.
//
// Call sites today:
//   - POST /api/dealers              → context="dealer create (Trial — onboarding workflow trigger)"
//   - PATCH /api/dealers/[id] on    → context="dealer update (plan / lifecycle change)"
//     account_type / lifecycle move
//
// Non-lifecycle field edits (address, phone, logo) still ride
// fireDealerSync to keep the normal-case latency down.

const RELIABLE_MAX_ATTEMPTS = 3;
const RELIABLE_BACKOFF_MS = [500, 1500, 4000]; // sleep BEFORE attempt 2 and 3

async function alertHubspotCreateFailure(args: {
  objectType: "company" | "contact";
  objectId: string;
  context: string;        // free text, e.g. "dealer create" / "dealer update (plan change)"
  attempts: number;
  lastError: string;
}): Promise<void> {
  try {
    await sendMandrillEmail({
      subject: `[HubSpot sync] ${args.context} FAILED after ${args.attempts}× retries`,
      from_email: "alerts@dealeraddendums.com",
      from_name: "DA Platform Alerts",
      to: [{ email: "support@dealeraddendums.com", name: "DA Support" }],
      html: `<p>HubSpot ${args.objectType} sync failed for ${args.context}.</p>
<p><b>Object id:</b> ${args.objectId}<br>
<b>Attempts:</b> ${args.attempts}<br>
<b>Last error:</b> <code>${args.lastError.replace(/</g, "&lt;").slice(0, 600)}</code></p>
<p>If the failed context was a Trial-stage create or a subscription_type /
lifecyclestage change, the corresponding HubSpot workflow did NOT enroll
automatically — replay manually from <code>hubspot_sync_errors</code> when
ready.</p>`,
    });
  } catch (err) {
    console.error("[hubspot-sync] alert send failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Reliable dealer Company upsert — same payload + write-back as
 * syncDealerToHubspot, but retries transient errors and alerts on
 * terminal failure. The single source of retry+alert behavior; use
 * for any operation that fires a HubSpot workflow (create with
 * lifecyclestage=Trial, paying↔Free transitions, etc.). For everything
 * else (address/phone/logo updates) use the plain fireDealerSync.
 *
 * Returns the resulting hubspot_company_id on success, null on failure.
 */
export async function syncDealerReliable(dealerId: string, context: string, opts?: { sourceForm?: string | null }): Promise<string | null> {
  if (!hubspotConfigured()) return null;
  // Test / Sales Demo dealers are excluded from HubSpot, so there is nothing to
  // retry and nothing has failed. Checked BEFORE the loop on purpose: the loop
  // confirms success by reading hubspot_company_id back, so a skipped sync
  // would otherwise burn 3 attempts and then Mandrill-alert support@ about a
  // "failure" on every single test-dealer create.
  if (!(await isRealAccountDealer(dealerId))) {
    console.log(`[sync-hubspot] ${context}: skipping dealer ${dealerId} — Test/Sales Demo excluded from HubSpot`);
    return null;
  }
  let lastError = "";
  for (let attempt = 1; attempt <= RELIABLE_MAX_ATTEMPTS; attempt++) {
    try {
      await syncDealerToHubspot(dealerId, opts);
      // syncDealerToHubspot swallows errors into hubspot_sync_errors, so
      // confirm success by reading the updated row back.
      const admin = createAdminSupabaseClient();
      const { data } = await admin.from("dealers").select("hubspot_company_id").eq("id", dealerId).maybeSingle<{ hubspot_company_id: string | null }>();
      if (data?.hubspot_company_id) return data.hubspot_company_id;
      lastError = "syncDealerToHubspot ran but hubspot_company_id was not written";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < RELIABLE_MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, RELIABLE_BACKOFF_MS[attempt - 1]));
    }
  }
  await alertHubspotCreateFailure({
    objectType: "company",
    objectId: dealerId,
    context,
    attempts: RELIABLE_MAX_ATTEMPTS,
    lastError,
  });
  return null;
}

/**
 * Back-compat: the create path keeps its dedicated entry point. Thin
 * wrapper around syncDealerReliable with the create-context string so
 * Mandrill alerts still call out the Marketing OS Phase 5 trigger.
 */
export async function syncDealerCreateReliable(dealerId: string, sourceForm?: string | null): Promise<string | null> {
  return syncDealerReliable(dealerId, "dealer create (Trial — onboarding workflow trigger)", { sourceForm });
}

/**
 * Fire-and-forget kickoff for dealer-create. Runs in background but
 * uses the reliable retry+alert variant so a flaky HubSpot doesn't
 * silently skip onboarding.
 */
export function fireDealerCreateReliable(dealerId: string, sourceForm?: string | null): void {
  void syncDealerCreateReliable(dealerId, sourceForm);
}

/**
 * Fire-and-forget kickoff for any lifecycle-affecting dealer update
 * (plan tier change, paying↔Free, etc.). Same retry+alert bar as the
 * create path because these edits fire HubSpot workflows.
 */
export function fireDealerReliable(dealerId: string, context: string): void {
  void syncDealerReliable(dealerId, context);
}

// ── Fire-and-forget convenience wrappers (call from route handlers) ─────────

/**
 * Account Purpose was changed on an existing dealer — reconcile the CRM so it
 * only ever holds real dealers.
 *
 *   → 'test' / 'sales_demo' : archive the Company and its primary Contact and
 *                             clear the stored ids, so a later flip back to
 *                             Real creates fresh records instead of PATCHing
 *                             archived ones.
 *   → 'real'                : create the records (reliable path).
 *
 * Archive is HubSpot's recoverable soft-delete (the same `archiveObject` the
 * dealer-delete cleanup uses), so nothing is destroyed — a mis-flag is undone
 * by flipping back, which creates a new record, or by restoring in HubSpot.
 *
 * Each call is individually caught: a CRM outage must never fail the operator's
 * purpose change, which is a platform-side edit.
 */
export async function applyAccountPurposeToHubspot(dealerUuid: string, newPurpose: string): Promise<void> {
  if (!hubspotConfigured()) return;
  const becomingReal = newPurpose === "real";
  if (becomingReal) {
    void syncDealerReliable(dealerUuid, "account purpose changed to Real");
    return;
  }
  try {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealer } = await (admin as any)
      .from("dealers")
      .select("id, dealer_id, name, hubspot_company_id, hubspot_primary_contact_id")
      .eq("id", dealerUuid)
      .maybeSingle() as { data: { id: string; dealer_id: string; name: string | null; hubspot_company_id: string | null; hubspot_primary_contact_id: string | null } | null };
    if (!dealer) return;

    // Contacts for this dealer's users, plus the stored primary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profs } = await (admin as any)
      .from("profiles")
      .select("id, hubspot_contact_id")
      .eq("dealer_id", dealer.dealer_id) as { data: Array<{ id: string; hubspot_contact_id: string | null }> | null };

    const contactIds = new Set<string>();
    if (dealer.hubspot_primary_contact_id) contactIds.add(dealer.hubspot_primary_contact_id);
    for (const pr of profs ?? []) if (pr.hubspot_contact_id) contactIds.add(pr.hubspot_contact_id);

    for (const cid of Array.from(contactIds)) {
      try { await archiveObject("contacts", cid); }
      catch (err) { console.error(`[sync-hubspot] archive contact ${cid} failed:`, err instanceof Error ? err.message : err); }
    }
    if (dealer.hubspot_company_id) {
      try { await archiveObject("companies", dealer.hubspot_company_id); }
      catch (err) { console.error(`[sync-hubspot] archive company ${dealer.hubspot_company_id} failed:`, err instanceof Error ? err.message : err); }
    }

    // Clear the ids so nothing later PATCHes an archived record.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (admin as any).from("dealers")
        .update({ hubspot_company_id: null, hubspot_primary_contact_id: null })
        .eq("id", dealerUuid);
      if ((profs ?? []).some(pr => pr.hubspot_contact_id)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (admin as any).from("profiles")
          .update({ hubspot_contact_id: null })
          .eq("dealer_id", dealer.dealer_id);
      }
    } catch (err) {
      console.error("[sync-hubspot] clearing hubspot ids failed:", err instanceof Error ? err.message : err);
    }

    console.log(`[sync-hubspot] dealer ${dealer.name ?? dealerUuid} flipped to ${newPurpose} — archived 1 company + ${contactIds.size} contact(s)`);
  } catch (err) {
    console.error("[sync-hubspot] applyAccountPurposeToHubspot failed:", err instanceof Error ? err.message : err);
  }
}

/** Fire-and-forget wrapper for the purpose-flip reconcile. */
export function fireAccountPurposeChange(dealerUuid: string, newPurpose: string): void {
  void applyAccountPurposeToHubspot(dealerUuid, newPurpose);
}

export function fireDealerSync(dealerId: string): void { void syncDealerToHubspot(dealerId); }
export function fireGroupSync(groupId: string, sourceForm?: string | null): void  { void syncGroupToHubspot(groupId, { sourceForm }); }
export function fireProfileSync(profileId: string): void { void syncProfileToHubspot(profileId); }
