/**
 * Checks for multi-term inventory search.
 *   npm run test:vehicle-search
 *
 * The bug: a pasted list ("T42746,T42675,T42720") went into each ilike raw,
 * and since `,` is the PostgREST `.or()` delimiter the whole logic tree failed
 * to parse. So the two things worth asserting are that terms are SPLIT, and
 * that whatever survives is QUOTED so a stray comma/paren can never again
 * reach the tree as syntax.
 */

import { tokenizeSearch, buildVehicleSearchOr, MAX_SEARCH_TERMS, VEHICLE_SEARCH_FIELDS } from "../lib/vehicle-search";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\nvehicle search — tokenizing + escaping\n");

// ── The reported case ──────────────────────────────────────────────────────
{
  const { terms } = tokenizeSearch("T42746,T42675,T42720");
  check("the reported paste splits into 3 terms", terms.length === 3 && terms[0] === "T42746" && terms[2] === "T42720");

  const tree = buildVehicleSearchOr(terms)!;
  check("  …builds one OR tree covering every term × every field",
    VEHICLE_SEARCH_FIELDS.every(f => terms.every(t => tree.includes(`${f}.ilike."%${t}%"`))));
  check("  …no raw unquoted comma-joined blob survives", !tree.includes("T42746,T42675"));
}

// ── Separators ─────────────────────────────────────────────────────────────
{
  check("commas separate", tokenizeSearch("a,b").terms.length === 2);
  check("spaces separate", tokenizeSearch("a b").terms.length === 2);
  check("newlines separate (pasted column)", tokenizeSearch("a\nb\nc").terms.length === 3);
  check("mixed + repeated separators tolerated", tokenizeSearch(" a,,  b \n\n, c ,").terms.join("|") === "a|b|c");
  check("empty query → no terms", tokenizeSearch("   ").terms.length === 0);
  check("empty query → null tree (caller skips .or)", buildVehicleSearchOr(tokenizeSearch("").terms) === null);
  check("duplicates collapse case-insensitively", tokenizeSearch("F-150, f-150").terms.length === 1);
}

// ── Escaping: the 8de784b lesson ───────────────────────────────────────────
{
  // A term can still contain the dangerous characters if it has no separator
  // next to them — parens and quotes are not separators.
  const tree = buildVehicleSearchOr(tokenizeSearch('Silverado(LT)').terms)!;
  check("parens are quoted, not left as tree syntax", tree.includes('stock_number.ilike."%Silverado(LT)%"'));

  const q = buildVehicleSearchOr(tokenizeSearch('say"hi').terms)!;
  check("embedded double quote is backslash-escaped", q.includes('\\"'));

  const b = buildVehicleSearchOr(tokenizeSearch("back\\slash").terms)!;
  check("embedded backslash is escaped", b.includes("\\\\"));

  check("every clause value is quoted",
    buildVehicleSearchOr(tokenizeSearch("a b c").terms)!
      .split(",")
      .every(c => /\.ilike\."%.*%"$/.test(c)));
}

// ── Year still works, and only for a real year ─────────────────────────────
{
  const y = buildVehicleSearchOr(tokenizeSearch("2024").terms)!;
  check("a 4-digit year adds year.eq", y.includes("year.eq.2024"));
  const n = buildVehicleSearchOr(tokenizeSearch("T42746").terms)!;
  check("a stock number does NOT add year.eq", !n.includes("year.eq"));
  const old = buildVehicleSearchOr(tokenizeSearch("1200").terms)!;
  check("an out-of-range number does NOT add year.eq", !old.includes("year.eq"));
  const off = buildVehicleSearchOr(tokenizeSearch("2024").terms, { includeYear: false })!;
  check("admin list can opt out of the year clause (no behavior change there)", !off.includes("year.eq"));
}

// ── Single term = exactly today's behavior ─────────────────────────────────
{
  const one = buildVehicleSearchOr(tokenizeSearch("F-150").terms)!;
  check("single term still ORs across all four fields (no regression)",
    one.split(",").length === VEHICLE_SEARCH_FIELDS.length);
  check("  …and stays a CONTAINS match, so partials keep working",
    one.includes('model.ilike."%F-150%"'));
}

// ── The cap is honest, not silent ──────────────────────────────────────────
{
  const many = Array.from({ length: MAX_SEARCH_TERMS + 5 }, (_, i) => `S${i}`).join(",");
  const r = tokenizeSearch(many);
  check(`over ${MAX_SEARCH_TERMS} terms is capped`, r.terms.length === MAX_SEARCH_TERMS);
  check("  …and reports truncated so the UI can say so", r.truncated === true);
  check("at the cap exactly, not flagged truncated",
    tokenizeSearch(Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `S${i}`).join(",")).truncated === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) { console.log("\nFAILED:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
