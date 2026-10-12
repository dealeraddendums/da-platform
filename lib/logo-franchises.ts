import { builderDb } from "@/lib/image-builder/access";
import { makeKey } from "@/lib/make-key";

// Franchise makes for Logo Studio's OEM-badge replacement (LogoForge Phase 3).
//
// DA has no franchise column. The best evidence of what a store is franchised
// for is what it sells NEW (a store's used lot carries every brand) plus any
// per-make template override it set up (template_make_overrides, migration 153).
// A make counts when it has at least MIN_NEW active new vehicles, so one
// mis-coded unit doesn't make a franchise. A group's franchises = the union of
// its member dealers'.
//
// Feed makes are dirty ("CHEVY", "MINI COOPER", "Land Rover ", "VW"), so each is
// mapped onto LogoForge's canonical make names (its make-logo library) by
// alias + longest canonical PREFIX, the same idea as lib/make-key.ts. A make
// that maps to nothing is simply not sent.

const MIN_NEW = 2;
const PAGE = 1000;
const MAX_ROWS = 30_000;

/** LogoForge library makes (da-logoforge library/manifest.json). */
const CANONICAL = [
  "Acura", "Alfa Romeo", "Aston Martin", "Audi", "BMW", "Bentley", "Buick", "Cadillac", "Chevrolet", "Chrysler",
  "Dodge", "Ferrari", "Fiat", "Ford", "GMC", "Genesis", "Honda", "Hyundai", "Infiniti", "Isuzu", "Jaguar", "Jeep",
  "Kia", "Land Rover", "Lexus", "Lincoln", "Lotus", "Maserati", "Mazda", "Mercedes-Benz", "Mini", "Mitsubishi",
  "Nissan", "Porsche", "Ram", "Rolls-Royce", "Subaru", "Toyota", "VinFast", "Volkswagen", "Volvo",
];
const ALIASES: Record<string, string> = {
  CHEVY: "Chevrolet", VW: "Volkswagen", MERCEDES: "Mercedes-Benz",
  RANGEROVER: "Land Rover", ALFA: "Alfa Romeo", ROLLS: "Rolls-Royce",
};
const BY_KEY = [...CANONICAL.map((m) => [makeKey(m), m] as const), ...Object.entries(ALIASES)]
  .sort((a, b) => b[0].length - a[0].length); // longest key wins

export function canonicalMake(raw: string | null | undefined): string | null {
  const k = makeKey(raw);
  if (!k) return null;
  for (const [key, name] of BY_KEY) if (k.startsWith(key)) return name;
  return null;
}

/** Canonical franchise makes for these dealers (text dealer_ids). */
export async function franchiseMakesForDealers(dealerTextIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(dealerTextIds.filter(Boolean)));
  if (!ids.length) return [];
  const db = builderDb(); // template_make_overrides isn't in the generated types
  const counts = new Map<string, number>();
  // PostgREST clamps every read to 1000 rows — page with .range().
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from("dealer_vehicles")
      .select("make")
      .in("dealer_id", ids)
      .eq("status", "active")
      .ilike("condition", "new")
      .range(from, from + PAGE - 1);
    if (error) { console.error("[logo-franchises] vehicles:", error.message); break; }
    for (const r of data ?? []) {
      const m = canonicalMake((r as { make: string | null }).make);
      if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    if (!data || data.length < PAGE) break;
  }
  const out = new Set(Array.from(counts).filter(([, n]) => n >= MIN_NEW).map(([m]) => m));
  const { data: overrides } = await db.from("template_make_overrides").select("make_key").in("dealer_id", ids);
  for (const o of overrides ?? []) {
    const m = canonicalMake((o as { make_key: string }).make_key);
    if (m) out.add(m);
  }
  return Array.from(out).sort();
}

export async function franchiseMakesForGroup(groupId: string): Promise<string[]> {
  const db = builderDb();
  const { data } = await db.from("dealers").select("dealer_id").eq("group_id", groupId).eq("active", true).range(0, 4999);
  return franchiseMakesForDealers(((data ?? []) as { dealer_id: string }[]).map((d) => d.dealer_id));
}
