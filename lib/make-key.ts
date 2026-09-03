// Canonical vehicle-make key, shared by everything that stores or matches a
// per-make template override.
//
// `dealer_vehicles.make` is feed data and is not clean. Real spellings in the
// fleet today, for just the brands this feature targets:
//
//   Hyundai 72,683 · HYUNDAI 15,631 · hyundai 58 · "hyundai " · "Hyundai "
//   BMW 37,517 · bmw 6 · "BMW SAV" · "BMW 5 SERIES" · "BMW 7 SERIES"
//   Genesis 9,830 · GENESIS 2,398 · genesis 5 · GENESISE
//   Land Rover 6,911 · LAND ROVER 706 · LANDROVER 13 · LandRover 2 · "land rover"
//   MINI 1,155 · Mini 978 · "MINI COOPER"
//   Jaguar 382 · JAGUAR 57
//
// Uppercasing and dropping every non-alphanumeric collapses all the case and
// spacing variants. Trim/typo/sub-model noise ("MINI COOPER", "BMW 5 SERIES",
// "GENESISE") is then handled by matching the override key as a PREFIX.

/** UPPERCASE, alphanumerics only. "Land Rover " -> "LANDROVER". */
export function makeKey(make: string | null | undefined): string {
  return String(make ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Does an override for `overrideKey` apply to a vehicle whose make is `make`?
 *
 * Prefix, not equality: "MINI COOPER" -> MINICOOPER must match an override on
 * MINI, and "BMW 5 SERIES" -> BMW5SERIES must match BMW.
 *
 * Known gap, deliberately not papered over: ~20 fleet rows have a whole
 * description in the make column ("2022 Hyundai Tucson SEL" -> 2022HYUNDAI...),
 * which starts with the year and so matches nothing. That is a feed
 * data-quality problem; a substring match would "fix" it at the cost of
 * matching real makes by accident, which is the worse trade for a branding
 * feature.
 */
export function makeMatches(overrideKey: string, make: string | null | undefined): boolean {
  const k = makeKey(overrideKey);
  if (!k) return false;
  return makeKey(make).startsWith(k);
}

/**
 * Pick the best override for a vehicle: LONGEST matching key wins.
 *
 * Length ordering is what keeps a two-brand rooftop correct. Some feeds emit
 * "Hyundai Genesis" (-> HYUNDAIGENESIS) which prefix-matches an override on
 * HYUNDAI; a more specific HYUNDAIGENESIS override must beat it. Without this,
 * whichever row the database happened to return first would win.
 */
export function pickByMake<T extends { make_key: string }>(rows: T[], make: string | null | undefined): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!makeMatches(r.make_key, make)) continue;
    if (!best || makeKey(r.make_key).length > makeKey(best.make_key).length) best = r;
  }
  return best;
}
