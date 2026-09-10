// Shared vehicle types and pure helpers — safe to import from client components.
// Do NOT add any Node.js / mysql2 imports here.

export type VehicleRow = {
  id: number;
  DEALER_ID: string;
  VIN_NUMBER: string;
  STOCK_NUMBER: string | null;
  YEAR: string | null;
  MAKE: string | null;
  MODEL: string | null;
  BODYSTYLE: string | null;
  TRIM: string | null;
  EXT_COLOR: string | null;
  INT_COLOR: string | null;
  ENGINE: string | null;
  FUEL: string | null;
  DRIVETRAIN: string | null;
  TRANSMISSION: string | null;
  MILEAGE: string | null;
  DATE_IN_STOCK: string | null;
  STATUS: "0" | "1";
  MSRP: string | null;
  NEW_USED: string;
  CERTIFIED: string;
  OPTIONS: string | null;
  PHOTOS: string | null;
  DESCRIPTION: string | null;
  PRINT_STATUS?: "0" | "1";
  supabase_printed?: boolean;
  /** Mobile print queue flag (dealer_vehicles.print_queue, migration 020). */
  print_queue?: number | null;
  HMPG: string | null;
  CMPG: string | null;
  MPG: string | null;
  UPDATE_DATE?: string | null;
  // Extended fields — populated from dealer_vehicles (migration 020)
  DOORS?: string | null;
  VDP_LINK?: string | null;
  WARRANTY_EXPIRES?: string | null;
  INSP_NUMB?: string | null;
  MSRP_ADJUSTMENT?: string | null;
  DISCOUNTED_PRICE?: string | null;
  INTERNET_PRICE?: string | null;
  CDJR_PRICE?: string | null;
  PRINT_DATE?: string | null;
  PRINT_GUIDE?: string | null;
  PRINT_INFO?: string | null;
  PRINT_QUEUE?: string | null;
  PRINT_USER?: string | null;
  PRINT_FLAG?: string | null;
  PRINT_SMS?: string | null;
  OPTIONS_ADDED?: string | null;
  RE_ORDER?: string | null;
  EDIT_STATUS?: string | null;
  EDIT_DATE?: string | null;
  INPUT_DATE?: string | null;
};

/** Parse pipe-separated PHOTOS string to array of URLs. */
export function parsePhotos(photos: string | null): string[] {
  if (!photos) return [];
  return photos.split("|").map((u) => u.trim()).filter(Boolean);
}

/** Parse comma-separated OPTIONS string to array of option strings. */
export function parseOptions(options: string | null): string[] {
  if (!options) return [];
  return options.split(",").map((o) => o.trim()).filter(Boolean);
}

/** Derive display condition from NEW_USED + CERTIFIED fields. */
export function vehicleCondition(v: { NEW_USED: string; CERTIFIED: string }): "New" | "Used" | "CPO" {
  if (v.CERTIFIED?.toLowerCase() === "yes") return "CPO";
  if (v.NEW_USED?.toLowerCase() === "used") return "Used";
  return "New";
}

// ── Certified / CPO resolution ───────────────────────────────────────────────
//
// A CPO vehicle arrives from every feed as condition='Used' PLUS a separate
// certified flag — nothing stores condition='CPO'. So certified has to be read,
// and read carefully.
//
// `dealer_vehicles.certified` is varchar(10) holding free text, and the live
// values are: "false"/"False" (1.72M), "No"/"N" (565k), ""/null (245k), "0",
// "true" (10k), "Y" (811), "1" (126) — plus roughly 4,000 rows holding
// four-character fragments of prose ("we o", "FLOR", "ensu", "and ", "look"),
// which is description text landing in the wrong column upstream.
//
// Every one of those non-empty strings is TRUTHY in JavaScript. A truthiness
// test would therefore mark 1,253,404 of 1,254,158 active vehicles as CPO —
// 99.94%, every New car included — and put CPO templates and CPO-targeted
// products on essentially every addendum printed. So this is an explicit
// allowlist of affirmatives, and anything unrecognised (including the
// corruption) falls through to the vehicle's plain condition, which is exactly
// today's behaviour for those rows.
//
// The allowlist is the one AddVehicleModal has always used, so hand-entered and
// feed-ingested vehicles agree on what "certified" means.
const CERTIFIED_AFFIRMATIVE = new Set([
  "yes", "y", "true", "t", "1", "x", "certified", "cert", "cpo",
]);

/** True when the raw `certified` column value actually asserts certification. */
export function isCertified(raw: string | boolean | null | undefined): boolean {
  if (raw === true) return true;
  if (raw === false || raw == null) return false;
  return CERTIFIED_AFFIRMATIVE.has(String(raw).trim().toLowerCase());
}

/**
 * The canonical New / Used / CPO for a dealer_vehicles row.
 *
 * Resolution order:
 *   1. certified flag asserts certification -> CPO
 *   2. condition itself says certified/cpo   -> CPO  (hand-edited rows, and
 *      anything a future feed writes that way)
 *   3. condition says used                   -> Used
 *   4. otherwise                             -> New
 *
 * Case-insensitive throughout. That matters: the previous inline resolvers read
 * `condition === "New" ? "new" : condition === "Used" ? "used" : "cpo"`, so the
 * 11,724 active rows stored as "NEW" and 445 stored as "USED" fell through the
 * final else and silently resolved to CPO — picking up CPO template overrides
 * and CPO product rules purely because of feed casing.
 */
export function resolveVehicleCondition(
  v: { condition?: string | null; certified?: string | boolean | null },
): "New" | "Used" | "CPO" {
  if (isCertified(v.certified)) return "CPO";
  const c = (v.condition ?? "").trim().toLowerCase();
  if (c === "certified" || c === "cpo" || c === "c") return "CPO";
  if (c === "used" || c === "u") return "Used";
  return "New";
}

/** The same answer shaped for the legacy NEW_USED / CERTIFIED pair that
 *  vehicleCondition() and the PDF/rules pipelines consume. Keeping one
 *  producer means the two can never disagree. */
export function vehicleConditionFields(
  v: { condition?: string | null; certified?: string | boolean | null },
): { NEW_USED: "New" | "Used"; CERTIFIED: "Yes" | "No" } {
  const cond = resolveVehicleCondition(v);
  return {
    // CPO is a used vehicle, so NEW_USED stays "Used" for it — the CERTIFIED
    // flag is what promotes it, exactly as vehicleCondition() expects.
    NEW_USED: cond === "New" ? "New" : "Used",
    CERTIFIED: cond === "CPO" ? "Yes" : "No",
  };
}
