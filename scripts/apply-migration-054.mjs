// One-shot applier for migration 054. Adds the `approved` column if missing
// (idempotent), flips the flag for the approved retail-manufacturer list,
// and reports any approved names that didn't match an nhtsa_makes row so
// we know if the catalog is missing any.

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: "/var/www/da-platform/.env.production" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const APPROVED = [
  "Acura","Alfa Romeo","Aston Martin","Audi","Bentley","BMW","Bugatti","Buick",
  "Cadillac","Chevrolet","Chrysler","Dodge","Ferrari","Fiat","Fisker","Ford",
  "Genesis","GMC","Honda","Hyundai","INEOS","Infiniti","Jaguar","Jeep","Kia",
  "Lamborghini","Land Rover","Lexus","Lincoln","Lotus","Lucid","Maserati",
  "Mazda","McLaren","Mercedes-Benz","MINI","Mitsubishi","Nissan","Pagani",
  "Polestar","Porsche","Ram","Rivian","Rolls-Royce","Subaru","Tesla","Toyota",
  "Volkswagen","Volvo",
];

// Walk paginated catalog (PostgREST default cap is 1000).
async function pageMakes() {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb
      .from("nhtsa_makes")
      .select("id, name")
      .order("id", { ascending: true })
      .range(from, from + 999);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const all = await pageMakes();
console.log(`Catalog: ${all.length} makes total.`);

const lowerToRow = new Map();
for (const r of all) lowerToRow.set(r.name.toLowerCase(), r);

const matchedIds = [];
const unmatched = [];
for (const name of APPROVED) {
  const row = lowerToRow.get(name.toLowerCase());
  if (row) matchedIds.push(row.id);
  else unmatched.push(name);
}

console.log(`Matched ${matchedIds.length}/${APPROVED.length} approved makes against nhtsa_makes.`);
if (unmatched.length) {
  console.log("Unmatched (skipped silently — modal's free-text Enter Make handles these):");
  for (const u of unmatched) console.log(`  - ${u}`);
}

// Flip the column. The migration SQL adds the column with DEFAULT false; if
// the column doesn't exist yet (migration not applied), this update will
// fail with a clear error and the user can apply migration 054 first.
const { error: updErr, count } = await sb
  .from("nhtsa_makes")
  .update({ approved: true })
  .in("id", matchedIds)
  .select("*", { count: "exact", head: true });

if (updErr) {
  console.error(`UPDATE failed: ${updErr.message}`);
  console.error("Apply migration 054 in Supabase first — it adds the `approved` column.");
  process.exit(1);
}
console.log(`Set approved=true on ${count ?? matchedIds.length} rows.`);

// Sanity check: count approved.
const { count: approvedCount } = await sb
  .from("nhtsa_makes")
  .select("*", { count: "exact", head: true })
  .eq("approved", true);
console.log(`Final approved count: ${approvedCount}`);
