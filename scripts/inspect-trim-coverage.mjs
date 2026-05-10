import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config({ path: "/var/www/da-platform/.env.production" });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

async function pageAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from(table).select(select).order("id").range(from, from + 999);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const { count: trimCount } = await sb.from("nhtsa_trims").select("*", { count: "exact", head: true });
console.log(`nhtsa_trims total: ${trimCount}`);

const makes = await pageAll("nhtsa_makes", "id, name");
const models = await pageAll("nhtsa_models", "id, name, make_id");
const trims = await pageAll("nhtsa_trims", "id, name, model_id");
console.log(`catalog: ${makes.length} makes, ${models.length} models, ${trims.length} trims`);

const makeById = new Map(makes.map(m => [m.id, m.name]));
const modelById = new Map(models.map(m => [m.id, m]));

const byKey = new Map();
const byMake = new Map();
for (const t of trims) {
  const m = modelById.get(t.model_id);
  if (!m) continue;
  const makeName = makeById.get(m.make_id) ?? "?";
  const key = `${makeName} ${m.name}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(t.name);
  byMake.set(makeName, (byMake.get(makeName) ?? 0) + 1);
}

console.log(`\nMake/model combos with trims: ${byKey.size}`);
console.log(`\nTop 15 makes by trim row count:`);
const makeRanked = [...byMake.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [m, c] of makeRanked) console.log(`  ${m.padEnd(20)} ${c}`);

const f150Entry = [...byKey.entries()].find(([k]) => k.toLowerCase().includes("f-150") || k.toLowerCase().includes("f150"));
console.log(`\nFord F-150: ${f150Entry ? `${f150Entry[1].length} trims` : "no rows"}`);
if (f150Entry) {
  const sample = f150Entry[1].slice(0, 15);
  for (const t of sample) console.log(`  - ${t}`);
  if (f150Entry[1].length > 15) console.log(`  …and ${f150Entry[1].length - 15} more`);
}
