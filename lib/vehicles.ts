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
  HMPG: string | null;
  CMPG: string | null;
  MPG: string | null;
  UPDATE_DATE?: string | null;
  // Extended fields — populated from dealer_vehicles (migration 020) or Aurora
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
