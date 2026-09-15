// Dealership-name normalization + similarity scoring for enrichment matching.
//
// Pure functions, no I/O — this file is what the unit suite
// (`npm run test:enrichment`) exercises, because the scoring thresholds are the
// only part of enrichment that can be wrong in a way that costs anything: a
// false `confirmed` writes a WRONG address onto a real dealer's record (and
// that address prints on addendums), while a false `needs_review` only costs
// Marlena thirty seconds.
//
// The hard case this exists for: dealerships are constantly bought, renamed and
// rebranded, so the name on a signup form and the name on the Google listing
// disagree routinely and innocently ("Bob Jones Ford" → "Springfield Ford" after
// a group buys it). That is NOT a match we may auto-accept, and it is also not
// something to silently discard — it's the definition of `needs_review`.

/** Words that carry no identifying signal in a dealership name. */
const STOPWORDS = new Set([
  "of", "the", "and", "at", "in", "on", "a",
  "inc", "incorporated", "llc", "lc", "ltd", "co", "corp", "company",
]);

/**
 * Dealer-trade abbreviations → their expanded token sequence.
 *
 * Expansion is what makes "Springfield CDJR" and "Springfield Chrysler Dodge
 * Jeep Ram" the same string instead of a 0.3 near-miss. Keys are matched as
 * WHOLE normalized tokens only, so "VW" expands but the "vw" inside a longer
 * word does not.
 *
 * Deliberately one-directional and franchise-only: no guessing at city or
 * family names, and nothing that would make two DIFFERENT brands collide.
 */
const ABBREVIATIONS: Record<string, string> = {
  // Stellantis alphabet soup — every ordering dealers actually use.
  cdjr: "chrysler dodge jeep ram",
  cjdr: "chrysler dodge jeep ram",
  cjd: "chrysler jeep dodge",
  cdj: "chrysler dodge jeep",
  jdr: "jeep dodge ram",
  dcjr: "dodge chrysler jeep ram",
  // Marques
  vw: "volkswagen",
  gmc: "gmc",            // identity: keeps GMC from being read as an initialism
  bmw: "bmw",
  mb: "mercedes benz",
  "mercedes-benz": "mercedes benz",
  mbz: "mercedes benz",
  chevy: "chevrolet",
  chev: "chevrolet",
  caddy: "cadillac",
  lr: "land rover",
  landrover: "land rover",
  jlr: "jaguar land rover",
  vol: "volvo",
  hyundai: "hyundai",
  kia: "kia",
  sub: "subaru",
  // Descriptors
  automotive: "auto",
  automobiles: "auto",
  automobile: "auto",
  motors: "motor",
  mtrs: "motor",
  dlr: "dealer",
  dealership: "dealer",
  dealerships: "dealer",
  grp: "group",
  pre: "pre",
  preowned: "pre owned",
  "pre-owned": "pre owned",
  used: "pre owned",
  cpo: "certified pre owned",
  ford: "ford",
  n: "and",
  "&": "and",
};

/**
 * Lowercase, strip punctuation, expand abbreviations, drop stopwords.
 * Returns the normalized token list (order preserved, duplicates collapsed).
 */
export function normalizeDealerName(raw: string): string[] {
  if (!raw) return [];
  const flattened = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip accents
    .replace(/&/g, " and ")
    // Possessives FIRST: stripping punctuation blindly turns "Bob's Ford" into
    // "bob s ford", and that stray "s" is a token that drags every comparison
    // with "Bob Ford" down.
    .replace(/['\u2019]s\b/g, "")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")        // punctuation → space
    .trim();

  const out: string[] = [];
  for (const token of flattened.split(/\s+/)) {
    if (!token) continue;
    const expanded = ABBREVIATIONS[token] ?? token;
    for (const piece of expanded.split(" ")) {
      if (!piece || STOPWORDS.has(piece)) continue;
      if (!out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

/** Normalized token list as a single comparable string. */
export function normalizedKey(raw: string): string {
  return normalizeDealerName(raw).join(" ");
}

/**
 * Token-set F1: harmonic mean of precision and recall over the two token sets.
 *
 * Chosen over plain overlap because it is symmetric and word-ORDER-blind —
 * "Toyota of Springfield" and "Springfield Toyota" score 1.0, which is right —
 * while still punishing extra or missing identifying words. "Jones Ford" vs
 * "Smith Ford" lands at 0.5 (one of two tokens shared): not a match, and a
 * textbook renamed store.
 */
function tokenF1(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter(t => setB.has(t)).length;
  if (shared === 0) return 0;
  const precision = shared / a.length;
  const recall = shared / b.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Sørensen–Dice coefficient over character bigrams of the whole normalized
 * string. Catches what tokenF1 can't: typos and spacing slips ("Chevrolet" vs
 * "Chevrolett") that shatter a token but barely move the bigram overlap.
 */
function diceBigrams(a: string, b: string): number {
  const grams = (s: string): string[] => {
    const g: string[] = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2));
    return g;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.length === 0 || gb.length === 0) return a === b ? 1 : 0;
  const pool = new Map<string, number>();
  for (const g of gb) pool.set(g, (pool.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of ga) {
    const n = pool.get(g) ?? 0;
    if (n > 0) { shared++; pool.set(g, n - 1); }
  }
  return (2 * shared) / (ga.length + gb.length);
}

/**
 * Similarity of two dealership names, 0..1.
 *
 * max() of the two measures rather than a blend: they fail in different,
 * non-overlapping ways (reordering vs typos), and each is already conservative
 * on its own, so taking the better of the two keeps a genuine match from being
 * dragged under the threshold by the measure that happens not to apply.
 */
export function nameSimilarity(signupName: string, candidateName: string): number {
  const ta = normalizeDealerName(signupName);
  const tb = normalizeDealerName(candidateName);
  const ka = ta.join(" "), kb = tb.join(" ");
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  return Math.max(tokenF1(ta, tb), diceBigrams(ka, kb));
}

export const CONFIRM_THRESHOLD = 0.8;
/**
 * Review floor, lowered 0.50 → 0.35 (Allan, 2026-09-15).
 *
 * At 0.50 a FULL rebrand fell through to no_match and was silently discarded:
 * "Bob Jones Ford" → "Springfield Ford" keeps only the franchise word, shares 1
 * of 3 tokens and scores 0.40. That is precisely the bought-and-renamed store
 * the review queue exists for, so it now reaches a human instead of vanishing.
 *
 * 0.35 is still well clear of noise — an unrelated business shares no tokens
 * and scores ~0 — and zip agreement is required regardless, so a low-scoring
 * candidate at the wrong address is still no_match.
 */
export const REVIEW_THRESHOLD = 0.35;

export type EnrichmentStatus = "confirmed" | "needs_review" | "no_match" | "error";

/**
 * The 5-digit US zip in a string, or null when there isn't a credible one.
 *
 * Accepts a bare 5-digit zip, ZIP+4 in either form ("94107-1234" / "941071234"),
 * and a zip embedded in a formatted address ("… Anniston, AL 36207, USA").
 *
 * REFUSES malformed digit runs (6, 7 or 8 digits) instead of truncating them.
 * Found in real data 2026-09-15: Oxmoor Hyundai's `dealers.zip` is "402299" —
 * a typo'd 40299. Taking the first five gave "40229", a valid-LOOKING but wrong
 * zip, which then failed to match Google's correct 40299 and produced a note
 * blaming Google ("is in zip 40299, not 40229"). There is no safe way to know
 * which digit was doubled, so the honest answer is "no usable zip" — which
 * routes to no_match with a note that points at our own data instead.
 *
 * When several 5-digit runs are present (a 5-digit street number plus a zip),
 * the LAST one wins: US addresses put the zip at the end.
 */
export function zip5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw);

  // ZIP+4 with a separator is unambiguous — take the leading five.
  const plus4 = s.match(/(\d{5})[-\s](\d{4})(?!\d)/);
  if (plus4) return plus4[1];

  const runs = s.match(/\d+/g);
  if (!runs) return null;

  const fives = runs.filter(r => r.length === 5);
  if (fives.length > 0) return fives[fives.length - 1];

  // Unseparated ZIP+4.
  const nines = runs.filter(r => r.length === 9);
  if (nines.length > 0) return nines[nines.length - 1].slice(0, 5);

  // 6/7/8 digits = a typo. Refuse rather than guess (see above).
  return null;
}

/**
 * The classification rule, isolated so it is testable and stated once.
 *
 * `zipMatches` is required for ANY accepted status: a dealership with the right
 * name in the wrong zip is a different rooftop of the same brand far more often
 * than it is our dealer, so it is a `no_match` and nothing is written. And zip
 * alone is never enough either — a Google listing under the new owner's group
 * name at the right address is exactly the `needs_review` case.
 */
export function classify(nameScore: number, zipMatches: boolean): EnrichmentStatus {
  if (!zipMatches) return "no_match";
  if (nameScore >= CONFIRM_THRESHOLD) return "confirmed";
  if (nameScore >= REVIEW_THRESHOLD) return "needs_review";
  return "no_match";
}

/** Consumer mailbox providers — never a dealer group's own domain. */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "passport.com",
  "aol.com", "aim.com", "icloud.com", "me.com", "mac.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
  "cox.net", "charter.net", "earthlink.net", "protonmail.com", "proton.me",
  "zoho.com", "gmx.com", "mail.com", "yandex.com", "duck.com",
]);

/**
 * Probable group domain from the contact email, or null for a consumer mailbox.
 * A shared domain across several signups is the strongest hint that separate
 * rooftops belong to one group.
 */
export function groupDomainFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  if (FREE_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}
