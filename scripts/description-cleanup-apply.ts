/**
 * Product description cleanup — dry run by default, `--apply` to write.
 * Converter: lib/product-description-clean.ts. Audit: docs/products/description-audit-20261023.md.
 *
 *   npx tsx scripts/description-cleanup-apply.ts                    # dry run, all dealers
 *   npx tsx scripts/description-cleanup-apply.ts --only=MP4062,lhmtoyota
 *   npx tsx scripts/description-cleanup-apply.ts --apply [--only=…]
 *
 * Runs from a machine with the Supabase CLI logged in: SQL goes through the
 * Management API (token from SUPABASE_ACCESS_TOKEN, else the CLI's keychain entry),
 * because the prod box has no direct Postgres and a per-dealer transaction needs
 * one SQL statement — each dealer is ONE statement (data-modifying CTEs across
 * addendum_library + vehicle_options), so it lands whole or not at all.
 *
 * Safety:
 *   - only `description` and `description_original` are written (migration 195)
 *   - description_original = coalesce(description_original, description): the
 *     first original is never overwritten
 *   - a row is written only if its description is still exactly what this run read
 *     (an edit made in between is skipped and counted, never clobbered)
 *   - re-running is a no-op for cleaned rows (the converter is idempotent)
 *
 * Revert one dealer: update <table> set description = description_original
 *                    where dealer_id = '…' and description_original is not null;
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { cleanProductDescription } from "../lib/product-description-clean";

const PROJECT = "byouefbebqgffhtfdggu";
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ONLY = (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = args.find((a) => a.startsWith("--out="))?.slice(6) ?? `description-cleanup-${APPLY ? "apply" : "dryrun"}-${new Date().toISOString().slice(0, 10)}.json`;

function token(): string {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const raw = execSync('security find-generic-password -s "Supabase CLI" -a supabase -w', { encoding: "utf8" }).trim();
  return raw.startsWith("go-keyring-base64:") ? Buffer.from(raw.slice(18), "base64").toString("utf8") : raw;
}
const TOKEN = token();

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (res.status === 429 && attempt < 5) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const body = await res.json();
    if (!res.ok || !Array.isArray(body)) throw new Error(`SQL failed (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
    return body as T[];
  }
}
const lit = (s: string | null) => (s === null ? "NULL" : `'${s.replace(/'/g, "''")}'`);

type Row = { id: string; owner: string; description: string };
type Table = "addendum_library" | "group_options" | "vehicle_options";
const OWNER: Record<Table, string> = { addendum_library: "dealer_id", vehicle_options: "dealer_id", group_options: "group_id::text" };

async function load(table: Table): Promise<Row[]> {
  const where = ONLY.length ? ` and ${OWNER[table]} in (${ONLY.map(lit).join(",")})` : "";
  const out: Row[] = [];
  for (let offset = 0; ; offset += 10000) {
    const page = await sql<Row>(`select id::text, ${OWNER[table]} as owner, description from public.${table} where coalesce(description,'') <> ''${where} order by id limit 10000 offset ${offset}`);
    out.push(...page);
    if (page.length < 10000) return out;
  }
}

function updateCte(name: string, table: Table, rows: { id: string; old: string; next: string }[]): string {
  const values = rows.map((r) => `(${lit(r.id)}::uuid, ${lit(r.old)}, ${lit(r.next)})`).join(",\n");
  return `${name} as (
  update public.${table} t
     set description_original = coalesce(t.description_original, t.description),
         description = v.next
    from (values ${values}) as v(id, old, next)
   where t.id = v.id and t.description = v.old
  returning 1)`;
}

async function main() {
  const [hasCol] = await sql<{ n: number }>(`select count(*)::int n from information_schema.columns where table_schema='public' and column_name='description_original' and table_name in ('addendum_library','group_options','vehicle_options')`);
  if (APPLY && hasCol.n !== 3) throw new Error("migration 195 (description_original) is not applied — refusing to write");

  const tables: Table[] = ["addendum_library", "group_options", "vehicle_options"];
  // owner → table → changes
  const plan = new Map<string, Partial<Record<Table, { id: string; old: string; next: string }[]>>>();
  const counts: Record<string, { rows: number; changed: number }> = {};
  for (const t of tables) {
    const rows = await load(t);
    let changed = 0;
    for (const r of rows) {
      const c = cleanProductDescription(r.description);
      if (!c.changed) continue;
      changed++;
      const p = plan.get(r.owner) ?? {};
      (p[t] ??= []).push({ id: r.id, old: r.description, next: c.html });
      plan.set(r.owner, p);
    }
    counts[t] = { rows: rows.length, changed };
  }
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — ${plan.size} owners`, counts);

  const log: { owner: string; planned: Record<string, number>; written?: Record<string, number>; error?: string }[] = [];
  for (const [owner, p] of Array.from(plan.entries())) {
    const planned = Object.fromEntries(Object.entries(p).map(([t, xs]) => [t, xs!.length]));
    if (!APPLY) { log.push({ owner, planned }); continue; }
    const ctes = (Object.keys(p) as Table[]).map((t, i) => updateCte(`u${i}`, t, p[t]!));
    const select = (Object.keys(p) as Table[]).map((t, i) => `(select count(*) from u${i})::int as "${t}"`).join(", ");
    try {
      const [written] = await sql<Record<string, number>>(`with ${ctes.join(",\n")}\nselect ${select}`);
      log.push({ owner, planned, written });
      const skipped = Object.keys(planned).some((t) => planned[t] !== written[t]);
      console.log(`  ${owner}: ${JSON.stringify(written)}${skipped ? `  (planned ${JSON.stringify(planned)} — rest edited since read, skipped)` : ""}`);
    } catch (e) {
      log.push({ owner, planned, error: String(e) });
      console.error(`  ${owner}: FAILED — nothing written for this dealer. ${String(e).slice(0, 200)}`);
    }
  }
  fs.writeFileSync(OUT, JSON.stringify({ apply: APPLY, only: ONLY, counts, owners: log }, null, 2));
  const failed = log.filter((l) => l.error).length;
  const written = log.reduce((n, l) => n + Object.values(l.written ?? {}).reduce((a, b) => a + b, 0), 0);
  console.log(APPLY ? `written ${written} rows, ${failed} dealers failed — log ${OUT}` : `dry run — nothing written, plan ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
