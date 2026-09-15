// Dealer enrichment pipeline: Google Places lookup → dealer_enrichment row →
// (confirmed only) fill the dealer's blank fields → PATCH the dealer's ALREADY
// LINKED HubSpot company.
//
// Entry points:
//   enrichDealer()      — the whole pipeline for one dealer. Used by the signup
//                         hook (fire-and-forget) and the backfill script.
//   lookupEnrichment()  — Places + scoring only, no writes. Used by tests.
//
// Three rules this module is built around:
//
//  1. NEVER BLOCK SIGNUP. enrichDealer never throws; every stage has its own
//     guard, and a missing API key/quota/outage degrades to a recorded `error`
//     row. Signup already succeeded by the time this runs.
//  2. THE DEALER'S OWN RECORD IS NEARLY SACRED. We only ever fill a field the
//     dealer left BLANK, and only from a `confirmed` finding. No overwrites —
//     a dealer-entered address is truth even when Google disagrees. (It also
//     prints on their addendums, which is the other reason not to guess.)
//  3. HUBSPOT: ENRICH, DON'T CREATE. The company is created and linked by the
//     live Phase-14 sync (lib/sync-hubspot.ts). Enrichment only PATCHes the
//     company id already stored on the dealer. No find-or-create, ever —
//     independent creation is how you get duplicate companies and shared-id
//     clobber (the 2026-07-15 Permaplate incident).

import { createAdminSupabaseClient } from "@/lib/db";
import { hubspotConfigured, getObjectProperties, patchObjectProperties } from "@/lib/hubspot";
import { isRealAccountDealer } from "@/lib/sync-hubspot";
import {
  buildDealershipQuery, placesConfigured, searchDealership, type PlaceCandidate,
} from "@/lib/enrichment/places";
import {
  classify, groupDomainFromEmail, nameSimilarity, zip5, type EnrichmentStatus,
} from "@/lib/enrichment/name-match";

export interface EnrichInput {
  dealerUuid: string;
  dealershipName: string;
  zip: string | null | undefined;
  contactEmail: string | null | undefined;
}

export interface EnrichmentResult {
  status: EnrichmentStatus;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  googlePlaceId: string | null;
  nameScore: number | null;
  groupDomain: string | null;
  /** Provenance for the stored row / operator explanation. */
  searchQuery: string;
  matchedName: string | null;
  notes: string | null;
}

/** Candidate source, injectable so the integration test can mock Places. */
export type SearchFn = (query: string) => Promise<PlaceCandidate[]>;

/**
 * Places lookup + scoring. No database, no HubSpot, no throwing.
 *
 * Scores EVERY candidate and keeps the best rather than trusting Google's #1:
 * a text search for "<name> dealership <zip>" frequently returns a nearby
 * same-brand rooftop first, and that rooftop is not our dealer.
 */
export async function lookupEnrichment(
  input: EnrichInput,
  search: SearchFn = (q) => searchDealership(q),
): Promise<EnrichmentResult> {
  const searchQuery = buildDealershipQuery(input.dealershipName, input.zip);
  const groupDomain = groupDomainFromEmail(input.contactEmail);
  const empty = (status: EnrichmentStatus, notes: string | null, nameScore: number | null = null): EnrichmentResult => ({
    status, street: null, city: null, state: null, zip: null, phone: null,
    googlePlaceId: null, nameScore, groupDomain, searchQuery, matchedName: null, notes,
  });

  if (!input.dealershipName?.trim()) return empty("no_match", "no dealership name on the signup");
  if (!placesConfigured()) return empty("error", "GOOGLE_PLACES_API_KEY not configured");

  const signupZip = zip5(input.zip);

  let candidates: PlaceCandidate[];
  try {
    candidates = await search(searchQuery);
  } catch (err) {
    return empty("error", `places lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (candidates.length === 0) return empty("no_match", "no Google Places results");

  // Score everything, best first. Zip agreement is checked against the
  // structured postal_code AND the formatted address — components are
  // occasionally absent, and a zip present only in the formatted string is
  // still a real zip agreement.
  const scored = candidates.map(c => {
    const candidateZip = zip5(c.zip);
    const zipMatches = !!signupZip && (
      candidateZip === signupZip ||
      (c.formattedAddress?.includes(signupZip) ?? false)
    );
    return { c, nameScore: nameSimilarity(input.dealershipName, c.name), zipMatches };
  }).sort((a, b) =>
    // Prefer zip agreement first, then name score: a perfect name in the wrong
    // zip must never outrank a decent name at the right one.
    (Number(b.zipMatches) - Number(a.zipMatches)) || (b.nameScore - a.nameScore)
  );

  const best = scored[0];
  const status = classify(best.nameScore, best.zipMatches);

  if (status === "no_match") {
    const why = !signupZip
      ? "signup had no usable zip, so no candidate could be confirmed"
      : !best.zipMatches
        ? `best candidate "${best.c.name}" is in zip ${best.c.zip ?? "?"}, not ${signupZip}`
        : `best candidate "${best.c.name}" scored ${best.nameScore.toFixed(2)} on name (below ${0.5})`;
    return empty("no_match", why, best.nameScore);
  }

  const notes = status === "needs_review"
    ? `zip ${signupZip} matches but the listing is named "${best.c.name}" (score ${best.nameScore.toFixed(2)}) — possible sale/rename, verify before calling`
    : best.c.businessStatus && best.c.businessStatus !== "OPERATIONAL"
      ? `Google reports businessStatus=${best.c.businessStatus}`
      : null;

  return {
    status,
    street: best.c.street,
    city: best.c.city,
    state: best.c.state,
    zip: zip5(best.c.zip) ?? best.c.zip,
    phone: best.c.phone,
    googlePlaceId: best.c.placeId,
    nameScore: best.nameScore,
    groupDomain,
    searchQuery,
    matchedName: best.c.name || null,
    notes,
  };
}

/** Is a dealer-supplied value effectively absent? */
function blank(v: unknown): boolean {
  return v == null || String(v).trim() === "";
}

export interface EnrichOutcome extends EnrichmentResult {
  /** Which of the dealer's own blank fields this filled (empty = none). */
  appliedToDealer: string[];
  /** Company id PATCHed, or null + reason in hubspotSkipped. */
  hubspotCompanyId: string | null;
  hubspotSkipped: string | null;
}

/**
 * Full pipeline for one dealer. NEVER THROWS.
 *
 * @param opts.dryRun   score + report, write nothing (backfill --dry-run)
 * @param opts.search   inject a Places stub (tests)
 */
export async function enrichDealer(
  input: EnrichInput,
  opts: { dryRun?: boolean; search?: SearchFn } = {},
): Promise<EnrichOutcome> {
  const result = await lookupEnrichment(input, opts.search);
  const outcome: EnrichOutcome = {
    ...result, appliedToDealer: [], hubspotCompanyId: null, hubspotSkipped: null,
  };

  try {
    const admin = createAdminSupabaseClient();

    // ── The dealer's current state: what's blank, and which company to PATCH.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dealer } = await (admin as any)
      .from("dealers")
      .select("id, address, city, state, zip, phone, hubspot_company_id")
      .eq("id", input.dealerUuid)
      .maybeSingle() as {
        data: {
          id: string; address: string | null; city: string | null; state: string | null;
          zip: string | null; phone: string | null; hubspot_company_id: string | null;
        } | null
      };
    if (!dealer) {
      outcome.hubspotSkipped = "dealer row not found";
      return outcome;
    }

    // ── Fill the dealer's BLANK fields — confirmed findings only.
    //    needs_review data never reaches the dealer record: it is unvetted, and
    //    the dealer's address prints on customer-facing addendums.
    const patch: Record<string, string> = {};
    if (result.status === "confirmed") {
      if (blank(dealer.address) && result.street) patch.address = result.street;
      if (blank(dealer.city) && result.city) patch.city = result.city;
      if (blank(dealer.state) && result.state) patch.state = result.state;
      if (blank(dealer.zip) && result.zip) patch.zip = result.zip;
      if (blank(dealer.phone) && result.phone) patch.phone = result.phone;
    }
    if (Object.keys(patch).length > 0 && !opts.dryRun) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).from("dealers").update(patch).eq("id", dealer.id);
      if (error) console.error("[enrichment] dealer fill failed:", error.message);
      else outcome.appliedToDealer = Object.keys(patch);
    } else {
      outcome.appliedToDealer = opts.dryRun ? Object.keys(patch) : [];
    }

    // ── HubSpot: PATCH the already-linked company (never create).
    try {
      const hs = await pushToHubspot(input.dealerUuid, dealer.hubspot_company_id, result, opts.dryRun === true);
      outcome.hubspotCompanyId = hs.companyId;
      outcome.hubspotSkipped = hs.skipped;
    } catch (err) {
      outcome.hubspotSkipped = `hubspot error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Record the finding regardless of status — that's the point of the table.
    if (!opts.dryRun) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (admin as any).from("dealer_enrichment").upsert({
        dealer_uuid: input.dealerUuid,
        enriched_address_street: result.street,
        enriched_address_city: result.city,
        enriched_address_state: result.state,
        enriched_address_zip: result.zip,
        enriched_phone: result.phone,
        google_place_id: result.googlePlaceId,
        enrichment_status: result.status,
        enrichment_name_score: result.nameScore,
        group_domain: result.groupDomain,
        hubspot_company_id: outcome.hubspotCompanyId,
        search_query: result.searchQuery,
        matched_name: result.matchedName,
        applied_to_dealer: outcome.appliedToDealer.length > 0,
        notes: result.notes,
        enriched_at: new Date().toISOString(),
      }, { onConflict: "dealer_uuid" });
      if (error) console.error("[enrichment] dealer_enrichment upsert failed:", error.message);
    }
  } catch (err) {
    console.error("[enrichment] pipeline error:", err instanceof Error ? err.message : err);
  }

  return outcome;
}

/**
 * PATCH the dealer's existing HubSpot company with confirmed/needs_review data.
 *
 * Returns { companyId, skipped } — companyId non-null only when we actually
 * wrote. Skips (never creates) when: the dealer is Test/Sales Demo, HubSpot
 * isn't configured, there's no linked company yet, or there's nothing worth
 * writing. A dealer whose company hasn't been created yet is picked up by a
 * later enrichment pass once the Phase-14 sync has linked one.
 */
async function pushToHubspot(
  dealerUuid: string,
  companyId: string | null,
  result: EnrichmentResult,
  dryRun: boolean,
): Promise<{ companyId: string | null; skipped: string | null }> {
  if (result.status !== "confirmed" && result.status !== "needs_review") {
    return { companyId: null, skipped: `nothing to write (status=${result.status})` };
  }
  if (!hubspotConfigured()) return { companyId: null, skipped: "HubSpot not configured" };

  // The Account-Purpose promise: Test / Sales Demo dealers are excluded from
  // HubSpot. Enrichment honours the same gate the create sync does — the
  // finding still lands in dealer_enrichment.
  if (!(await isRealAccountDealer(dealerUuid))) {
    return { companyId: null, skipped: "test/sales-demo dealer — excluded from HubSpot" };
  }
  if (!companyId) {
    return { companyId: null, skipped: "no hubspot_company_id yet — the create sync owns creation; will PATCH on a later pass" };
  }

  // Fill blanks only: read what the CRM already has so a human's better value
  // isn't replaced by our guess.
  const existing = await getObjectProperties("companies", companyId, ["address", "city", "state", "zip", "phone"]);
  if (existing === null) {
    // 404 — deleted or merged in the portal. Creating a replacement is the
    // create-sync's job, not ours.
    return { companyId: null, skipped: `HubSpot company ${companyId} not found (deleted/merged)` };
  }

  const props: Record<string, string> = {};
  if (blank(existing.address) && result.street) props.address = result.street;
  if (blank(existing.city) && result.city) props.city = result.city;
  if (blank(existing.state) && result.state) props.state = result.state;
  if (blank(existing.zip) && result.zip) props.zip = result.zip;
  if (blank(existing.phone) && result.phone) props.phone = result.phone;

  if (dryRun) return { companyId, skipped: Object.keys(props).length ? null : "all CRM fields already populated" };

  if (Object.keys(props).length > 0) {
    await patchObjectProperties("companies", companyId, props);
  }

  // The review flag goes in its own PATCH, with its own try/catch: it's a
  // CUSTOM property, and if it doesn't exist in the portal yet HubSpot 400s the
  // whole request. Separating it means a missing property can never cost us the
  // address/phone write above.
  if (result.status === "needs_review") {
    try {
      await patchObjectProperties("companies", companyId, { da_enrichment_status: "needs_review" });
    } catch (err) {
      console.warn(
        `[enrichment] could not set da_enrichment_status on company ${companyId} — ` +
        `create the property in HubSpot portal 23896347 (single-line text or dropdown). ` +
        `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return { companyId, skipped: Object.keys(props).length ? null : "all CRM fields already populated" };
}

/**
 * Fire-and-forget hook for the provisioning paths.
 *
 * Deliberately not awaited by the caller and swallowing everything: a signup
 * must not fail, or wait, because Google was slow.
 */
export function fireDealerEnrichment(input: EnrichInput): void {
  if (!placesConfigured()) {
    console.warn("[enrichment] skipped — GOOGLE_PLACES_API_KEY not set");
    return;
  }
  void enrichDealer(input)
    .then(r => console.log(
      `[enrichment] ${input.dealerUuid} status=${r.status} score=${r.nameScore?.toFixed(2) ?? "—"} ` +
      `filled=[${r.appliedToDealer.join(",")}] hubspot=${r.hubspotCompanyId ?? r.hubspotSkipped ?? "none"}`
    ))
    .catch(err => console.error("[enrichment] unexpected:", err instanceof Error ? err.message : err));
}
