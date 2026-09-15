// Google Places API (New) text-search client — the only network call in the
// enrichment path.
//
// Uses places.googleapis.com/v1/places:searchText, NOT the legacy
// maps.googleapis.com/maps/api/place/textsearch endpoint: the legacy Places API
// is closed to new projects, so a fresh key would simply fail against it.
//
// ⚠️ COST: the Places API (New) bills per request by SKU, and the SKU is chosen
// by the FIELD MASK, not by the query. Asking for a phone number
// (nationalPhoneNumber) is an Enterprise-tier field, which is the tier this
// module bills at. Trimming the mask to Pro fields (address only, no phone)
// would drop it a tier — but the phone number is half the point of enriching a
// signup that arrived without one. Keep the mask as small as the feature
// actually needs; every field added can only raise the bill.

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

/**
 * Exactly the fields enrichment consumes. addressComponents is what gives us a
 * structured street/city/state/zip; formattedAddress alone can't be split
 * reliably across US address formats.
 */
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.nationalPhoneNumber",
  "places.businessStatus",
].join(",");

export interface PlaceCandidate {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  businessStatus: string | null;
}

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
  nationalPhoneNumber?: string;
  businessStatus?: string;
}

export function placesConfigured(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

function pick(components: AddressComponent[], type: string, short = false): string | null {
  const hit = components.find(c => Array.isArray(c.types) && c.types.includes(type));
  if (!hit) return null;
  const val = short ? (hit.shortText ?? hit.longText) : (hit.longText ?? hit.shortText);
  return val?.trim() || null;
}

function toCandidate(p: RawPlace): PlaceCandidate | null {
  if (!p.id) return null;
  const components = p.addressComponents ?? [];
  const streetNumber = pick(components, "street_number");
  const route = pick(components, "route");
  return {
    placeId: p.id,
    name: p.displayName?.text?.trim() ?? "",
    formattedAddress: p.formattedAddress?.trim() ?? null,
    street: [streetNumber, route].filter(Boolean).join(" ") || null,
    // Dealerships sit in unincorporated areas often enough that `locality` is
    // sometimes absent; postal_town / sublocality are the usual stand-ins.
    city: pick(components, "locality")
      ?? pick(components, "postal_town")
      ?? pick(components, "sublocality_level_1")
      ?? pick(components, "administrative_area_level_3"),
    state: pick(components, "administrative_area_level_1", true),
    zip: pick(components, "postal_code"),
    phone: p.nationalPhoneNumber?.trim() ?? null,
    businessStatus: p.businessStatus ?? null,
  };
}

export class PlacesError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = "PlacesError";
  }
}

/**
 * Text-search for a dealership. Returns up to `maxResults` candidates in
 * Google's own relevance order; scoring/acceptance is the caller's job
 * (lib/enrichment/name-match.ts) — this function never decides a match.
 *
 * Throws PlacesError on a non-2xx so the caller can record `error` status and
 * let the backfill retry; a missing key is the caller's check (placesConfigured).
 */
export async function searchDealership(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<PlaceCandidate[]> {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new PlacesError(0, "GOOGLE_PLACES_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        maxResultCount: Math.min(Math.max(opts.maxResults ?? 5, 1), 20),
        languageCode: "en",
        regionCode: "US",
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new PlacesError(res.status, `places:searchText ${res.status}`, text.slice(0, 500));
    }
    const json = JSON.parse(text) as { places?: RawPlace[] };
    // An empty/absent `places` array is a legitimate "nothing found", not an error.
    return (json.places ?? []).map(toCandidate).filter((c): c is PlaceCandidate => c !== null);
  } catch (err) {
    if (err instanceof PlacesError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new PlacesError(0, `places:searchText timed out after ${opts.timeoutMs ?? 8000}ms`);
    }
    throw new PlacesError(0, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** The query shape enrichment searches with — one place, so tests can assert it. */
export function buildDealershipQuery(dealershipName: string, zip: string | null | undefined): string {
  return [dealershipName.trim(), "dealership", (zip ?? "").trim()].filter(Boolean).join(" ");
}
