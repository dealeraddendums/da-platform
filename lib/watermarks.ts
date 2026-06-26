// Watermark brand logos — the legacy `addendum-watermarks` S3 bucket
// (us-east-1; public read on objects, but bucket LISTING is denied). Files are
// named by brand, e.g. `Honda.png`, `BMW.png`, `Alfa Romeo.png` (spaces are
// encoded as %20 in the URL).
//
// The brand list below is the authoritative set of files confirmed to exist in
// the bucket (verified by HEAD-checking each candidate — we can't list it). If
// a brand 404/403s it simply isn't here; keep this list to what actually exists
// so the picker never shows a broken thumbnail.

export const WATERMARK_BUCKET = "https://addendum-watermarks.s3.amazonaws.com";

export const WATERMARK_BRANDS: string[] = [
  "Abarth", "Acura", "Alfa Romeo", "Aston Martin", "Audi", "BMW", "Buick",
  "Cadillac", "CDJR", "Chevrolet", "Chrysler", "Dodge", "Ferrari", "Fiat",
  "Fiskers", "Ford", "Genesis", "GM", "GMC", "Honda", "Hyundai", "Infiniti",
  "Jaguar", "Jeep", "Kia", "Lamborghini", "Land Rover", "Lexus", "Lincoln",
  "Lotus", "Maybach", "Mazda", "Mercedes-Benz", "Mercury", "Mini", "Mitsubishi",
  "Nissan", "Polestar", "Pontiac", "Porsche", "Ram", "Saab", "Subaru", "Suzuki",
  "Tesla", "Toyota", "VW", "Volvo",
];

/** Public URL for a brand's watermark PNG (spaces → %20). */
export function watermarkUrl(brand: string): string {
  return `${WATERMARK_BUCKET}/${encodeURIComponent(brand)}.png`;
}

// Vehicle make → brand-file aliases, for `mode:auto`. Exact brand names are
// matched case-insensitively first; these cover makes that don't equal a file.
const MAKE_ALIASES: Record<string, string> = {
  volkswagen: "VW",
  vw: "VW",
  mercedes: "Mercedes-Benz",
  "mercedes benz": "Mercedes-Benz",
  "mercedes-benz": "Mercedes-Benz",
  mercedesbenz: "Mercedes-Benz",
  chevy: "Chevrolet",
  "land-rover": "Land Rover",
  landrover: "Land Rover",
  "range rover": "Land Rover",
  rover: "Land Rover",
  "general motors": "GM",
  "alfa-romeo": "Alfa Romeo",
  alfaromeo: "Alfa Romeo",
};

const BRAND_BY_NORM = new Map(WATERMARK_BRANDS.map((b) => [b.toLowerCase(), b]));

/** Resolve a vehicle make to an existing brand file, or null if none matches. */
export function resolveBrandForMake(make: string | null | undefined): string | null {
  if (!make) return null;
  const norm = make.trim().toLowerCase();
  if (!norm) return null;
  if (BRAND_BY_NORM.has(norm)) return BRAND_BY_NORM.get(norm)!;
  if (MAKE_ALIASES[norm]) return MAKE_ALIASES[norm];
  // Last resort: first word (e.g. a make that carries a trim suffix).
  const first = norm.split(/\s+/)[0];
  if (BRAND_BY_NORM.has(first)) return BRAND_BY_NORM.get(first)!;
  if (MAKE_ALIASES[first]) return MAKE_ALIASES[first];
  return null;
}
