/**
 * Unit + integration checks for the dealer-enrichment matcher.
 *   npm run test:enrichment
 *
 * No network, no database: the scoring functions are pure, and the one
 * integration case injects a stubbed Places search + a stubbed lookup so the
 * happy path is exercised end-to-end without touching Google or Supabase.
 *
 * The scoring thresholds are the only thing here worth testing, because a false
 * `confirmed` writes a wrong address onto a real dealer's record (and that
 * address prints on their addendums), while a false `needs_review` costs
 * someone half a minute.
 */

import {
  classify, groupDomainFromEmail, nameSimilarity, normalizeDealerName,
  normalizedKey, zip5, CONFIRM_THRESHOLD, REVIEW_THRESHOLD,
} from "../lib/enrichment/name-match";
import { buildDealershipQuery, type PlaceCandidate } from "../lib/enrichment/places";
import { lookupEnrichment } from "../lib/enrichment/dealerEnrich";

let pass = 0, fail = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ""}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function score(a: string, b: string): number {
  return Number(nameSimilarity(a, b).toFixed(3));
}

function statusOf(signup: string, candidate: string, zipMatches: boolean) {
  return classify(nameSimilarity(signup, candidate), zipMatches);
}

// ── 1. Normalization ────────────────────────────────────────────────────────
console.log("\n1. Normalization");
check("lowercases + strips punctuation",
  normalizedKey("Bob's Ford, Inc.") === "bob ford",
  normalizedKey("Bob's Ford, Inc."));
check("drops corporate suffixes (Inc/LLC) and stopwords (of/the)",
  normalizedKey("Toyota of the Valley LLC") === "toyota valley",
  normalizedKey("Toyota of the Valley LLC"));
check("expands CDJR → chrysler dodge jeep ram",
  normalizedKey("Springfield CDJR") === "springfield chrysler dodge jeep ram",
  normalizedKey("Springfield CDJR"));
check("expands the CJDR ordering identically",
  normalizedKey("Springfield CJDR") === normalizedKey("Springfield CDJR"));
check("expands VW → volkswagen",
  normalizedKey("Kerry VW") === "kerry volkswagen", normalizedKey("Kerry VW"));
check("GMC stays GMC (not split into letters)",
  normalizeDealerName("Baker GMC").includes("gmc"), normalizedKey("Baker GMC"));
check("& becomes 'and'",
  normalizedKey("H&H Kia") === normalizedKey("H and H Kia"),
  `${normalizedKey("H&H Kia")} vs ${normalizedKey("H and H Kia")}`);
check("strips accents",
  normalizedKey("Peña Motors") === "pena motor", normalizedKey("Peña Motors"));

// ── 2. Similarity ───────────────────────────────────────────────────────────
console.log("\n2. Similarity scoring");
check("exact match = 1.0", score("Sunny King Honda", "Sunny King Honda") === 1);
check("exact match ignoring case/punctuation = 1.0",
  score("SUNNY KING HONDA!", "Sunny King Honda") === 1);
check("word order does not matter (Toyota of Springfield ↔ Springfield Toyota)",
  score("Toyota of Springfield", "Springfield Toyota") === 1,
  String(score("Toyota of Springfield", "Springfield Toyota")));
check("abbreviation expansion makes CDJR match the spelled-out name ≥ 0.8",
  score("Springfield CDJR", "Springfield Chrysler Dodge Jeep Ram") >= CONFIRM_THRESHOLD,
  String(score("Springfield CDJR", "Springfield Chrysler Dodge Jeep Ram")));
check("added franchise scores ≥ 0.8 (Jones Ford ↔ Jones Ford Lincoln)",
  score("Jones Ford", "Jones Ford Lincoln") >= CONFIRM_THRESHOLD,
  String(score("Jones Ford", "Jones Ford Lincoln")));
check("typo still scores ≥ 0.8 (Chevrolet ↔ Chevrolett)",
  score("Midway Chevrolet", "Midway Chevrolett") >= CONFIRM_THRESHOLD,
  String(score("Midway Chevrolet", "Midway Chevrolett")));
check("renamed store lands in the review band, NOT confirmed (Jones Ford ↔ Smith Ford)",
  score("Jones Ford", "Smith Ford") >= REVIEW_THRESHOLD && score("Jones Ford", "Smith Ford") < CONFIRM_THRESHOLD,
  String(score("Jones Ford", "Smith Ford")));
check("unrelated dealership scores below the review floor",
  score("Sunny King Honda", "Baker Motors Buick GMC") < REVIEW_THRESHOLD,
  String(score("Sunny King Honda", "Baker Motors Buick GMC")));
check("empty name scores 0", score("", "Anything Ford") === 0);

// ── 3. Classification (the acceptance rule) ─────────────────────────────────
console.log("\n3. Classification");
check("exact name + zip match → confirmed",
  statusOf("Sunny King Honda", "Sunny King Honda", true) === "confirmed");
check("renamed store + zip match → needs_review (a human vets it)",
  statusOf("Jones Ford", "Smith Ford", true) === "needs_review",
  statusOf("Jones Ford", "Smith Ford", true));
// ⚠️ THRESHOLD TENSION, documented deliberately rather than papered over.
// The spec asks for two things that don't quite meet: the review band is
// "0.5–0.8", but it also says a listing under a NEW GROUP NAME at the right zip
// "must land in needs_review". A rename that keeps only the franchise word
// ("Bob Jones Ford" → "Springfield Ford") shares 1 of 3 tokens and scores 0.40,
// which the 0.5 floor sends to no_match. These two tests pin the CURRENT
// behavior (spec numbers as written) so a future threshold change is a visible,
// deliberate edit rather than a silent drift. Lowering REVIEW_THRESHOLD to ~0.35
// is the one-line change that would move this case to needs_review.
check("rename keeping only the franchise word scores 0.40 (below the 0.5 floor)",
  score("Bob Jones Ford", "Springfield Ford") === 0.4,
  String(score("Bob Jones Ford", "Springfield Ford")));
check("…so at the 0.5 floor it lands in no_match, not needs_review",
  statusOf("Bob Jones Ford", "Springfield Ford", true) === "no_match",
  statusOf("Bob Jones Ford", "Springfield Ford", true));
check("partial rebrand DOES reach needs_review (Sunny King Honda ↔ King Automotive Honda)",
  statusOf("Sunny King Honda", "King Automotive Honda", true) === "needs_review",
  `${statusOf("Sunny King Honda", "King Automotive Honda", true)} (score ${score("Sunny King Honda", "King Automotive Honda")})`);
check("dropping an owner's first name is still the same store → confirmed (Bob Jones Ford ↔ Jones Ford)",
  statusOf("Bob Jones Ford", "Jones Ford", true) === "confirmed",
  `${statusOf("Bob Jones Ford", "Jones Ford", true)} (score ${score("Bob Jones Ford", "Jones Ford")})`);
check("WRONG-CITY same-name store → no_match even on a PERFECT name",
  statusOf("Sunny King Honda", "Sunny King Honda", false) === "no_match",
  statusOf("Sunny King Honda", "Sunny King Honda", false));
check("zip match alone (garbage name) is never accepted",
  statusOf("Sunny King Honda", "Joe's Taqueria", true) === "no_match",
  statusOf("Sunny King Honda", "Joe's Taqueria", true));
check("0.8 is inclusive for confirmed", classify(0.8, true) === "confirmed");
check("just under 0.8 is needs_review", classify(0.799, true) === "needs_review");
check("0.5 is inclusive for needs_review", classify(0.5, true) === "needs_review");
check("just under 0.5 is no_match", classify(0.499, true) === "no_match");

// ── 4. Zip + group domain ───────────────────────────────────────────────────
console.log("\n4. Zip parsing + group domain");
check("zip5 takes the 5-digit prefix of a ZIP+4", zip5("94107-1234") === "94107");
check("zip5 of null is null", zip5(null) === null);
check("zip5 ignores surrounding text", zip5("Springfield, IL 62704, USA") === "62704");
check("group domain from a dealer address",
  groupDomainFromEmail("gm@sunnykinghonda.com") === "sunnykinghonda.com");
check("gmail is ignored", groupDomainFromEmail("someone@gmail.com") === null);
check("yahoo is ignored", groupDomainFromEmail("someone@yahoo.com") === null);
check("outlook/hotmail ignored",
  groupDomainFromEmail("a@outlook.com") === null && groupDomainFromEmail("a@hotmail.com") === null);
check("malformed email → null", groupDomainFromEmail("not-an-email") === null);
check("search query shape",
  buildDealershipQuery("Sunny King Honda", "36201") === "Sunny King Honda dealership 36201",
  buildDealershipQuery("Sunny King Honda", "36201"));
check("search query omits a missing zip",
  buildDealershipQuery("Sunny King Honda", null) === "Sunny King Honda dealership");

// The integration half is async, and tsx compiles this script to CJS (no
// top-level await) — so it runs inside main().
async function main(): Promise<void> {
  // ── 5. Integration: full lookup with a stubbed Places search ────────────────
  console.log("\n5. Integration (stubbed Places, no network/DB)");

  const place = (over: Partial<PlaceCandidate>): PlaceCandidate => ({
    placeId: "PLACE_DEFAULT", name: "Unnamed", formattedAddress: null,
    street: null, city: null, state: null, zip: null, phone: null,
    businessStatus: "OPERATIONAL", ...over,
  });

  const REAL = place({
    placeId: "ChIJ_realStore", name: "Sunny King Honda",
    formattedAddress: "1507 S Quintard Ave, Anniston, AL 36201, USA",
    street: "1507 S Quintard Ave", city: "Anniston", state: "AL", zip: "36201",
    phone: "(256) 831-5300",
  });
  const OTHER_ROOFTOP = place({
    placeId: "ChIJ_otherRooftop", name: "Sunny King Honda",
    formattedAddress: "900 Main St, Birmingham, AL 35203, USA",
    street: "900 Main St", city: "Birmingham", state: "AL", zip: "35203",
    phone: "(205) 555-0100",
  });

  // The key needs to look configured for lookupEnrichment to proceed; the search
  // itself is stubbed, so nothing leaves the process.
  const priorKey = process.env.GOOGLE_PLACES_API_KEY;
  process.env.GOOGLE_PLACES_API_KEY = "test-key-not-used";

  const happy = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: "gm@sunnykinghonda.com" },
    async () => [REAL],
  );
  check("happy path → confirmed", happy.status === "confirmed", happy.status);
  check("happy path extracts street", happy.street === "1507 S Quintard Ave", String(happy.street));
  check("happy path extracts city/state/zip",
    happy.city === "Anniston" && happy.state === "AL" && happy.zip === "36201",
    `${happy.city}/${happy.state}/${happy.zip}`);
  check("happy path extracts phone", happy.phone === "(256) 831-5300", String(happy.phone));
  check("happy path keeps the place id", happy.googlePlaceId === "ChIJ_realStore");
  check("happy path infers the group domain", happy.groupDomain === "sunnykinghonda.com");

  // Google's #1 result is the wrong rooftop; the right-zip one is #2.
  const reordered = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => [OTHER_ROOFTOP, REAL],
  );
  check("picks the right-ZIP rooftop even when Google ranks another first",
    reordered.status === "confirmed" && reordered.googlePlaceId === "ChIJ_realStore",
    `${reordered.status}/${reordered.googlePlaceId}`);

  const wrongCity = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => [OTHER_ROOFTOP],
  );
  check("only a wrong-city same-name store → no_match, nothing extracted",
    wrongCity.status === "no_match" && wrongCity.street === null && wrongCity.phone === null,
    wrongCity.status);

  // Partial rebrand at the right zip: the needs_review case (score 0.67).
  const renamed = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => [place({
      placeId: "ChIJ_renamed", name: "King Automotive Honda",
      formattedAddress: "5 Auto Row, Anniston, AL 36201, USA",
      street: "5 Auto Row", city: "Anniston", state: "AL", zip: "36201", phone: "(256) 555-0111",
    })],
  );
  check("bought/renamed store → needs_review but data IS captured",
    renamed.status === "needs_review" && renamed.street === "5 Auto Row" && renamed.phone === "(256) 555-0111",
    renamed.status);
  check("needs_review carries an explanation for the operator",
    !!renamed.notes && renamed.notes.includes("verify"), String(renamed.notes));
  // A wholesale rebrand (franchise word only) falls under the floor — see the
  // threshold-tension note above. Nothing is written anywhere in this case.
  const rebranded = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Bob Jones Ford", zip: "36201", contactEmail: null },
    async () => [place({
      placeId: "ChIJ_rebranded", name: "Springfield Ford",
      formattedAddress: "5 Auto Row, Anniston, AL 36201, USA",
      street: "5 Auto Row", city: "Anniston", state: "AL", zip: "36201", phone: "(256) 555-0111",
    })],
  );
  check("full rebrand (franchise word only) → no_match at the current 0.5 floor",
    rebranded.status === "no_match" && rebranded.street === null,
    rebranded.status);

  const noResults = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Nonexistent Motors", zip: "36201", contactEmail: null },
    async () => [],
  );
  check("zero Places results → no_match", noResults.status === "no_match", noResults.status);

  const blewUp = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => { throw new Error("places:searchText 429"); },
  );
  check("Places failure → error status, never a throw", blewUp.status === "error", blewUp.status);
  check("error status records why", !!blewUp.notes && blewUp.notes.includes("429"), String(blewUp.notes));

  // zip agreement found only in formattedAddress (components absent)
  const looseZip = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => [place({
      placeId: "ChIJ_loose", name: "Sunny King Honda",
      formattedAddress: "1507 S Quintard Ave, Anniston, AL 36201, USA", zip: null,
    })],
  );
  check("zip present only in formattedAddress still counts as a match",
    looseZip.status === "confirmed", looseZip.status);

  // missing key → error (degrades, never throws)
  delete process.env.GOOGLE_PLACES_API_KEY;
  const unconfigured = await lookupEnrichment(
    { dealerUuid: "u1", dealershipName: "Sunny King Honda", zip: "36201", contactEmail: null },
    async () => [REAL],
  );
  check("no API key → error status, no throw", unconfigured.status === "error", unconfigured.status);
  if (priorKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = priorKey;

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }

}

void main();
