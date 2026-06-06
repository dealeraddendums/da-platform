/**
 * READ-ONLY audit: platform ↔ da-billing customer link (billing_customer_id).
 * docs/platform-billing-link-sync.md step 1–2. No writes. Run:
 *   npx tsx scripts/billing-link-audit.ts
 *
 * Pulls da-billing customers + templates (its kv_store) and platform groups +
 * dealers, then reports match rate per candidate key and categorizes each
 * platform entity (synced / link-missing / genuinely-new / mismatch-orphan).
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// ── Load env (tsx doesn't auto-load .env). Tries ENV_FILE, then .env.local /
//    .env.production next to the app root. Missing files are skipped; any vars
//    already present in process.env are kept as a fallback. ──────────────────
const envCandidates = [
  process.env.ENV_FILE,
  new URL("../.env.local", import.meta.url).pathname,
  new URL("../.env.production", import.meta.url).pathname,
].filter((p): p is string => Boolean(p));
for (const file of envCandidates) {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  console.log(`[env] loaded ${file}`);
  break;
}

const plat = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bill = createClient(process.env.DA_BILLING_SUPABASE_URL!, process.env.DA_BILLING_SERVICE_ROLE_KEY!);
const KV = "kv_store_0ecc29ad";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

async function kvByPrefix(prefix: string): Promise<any[]> {
  // Paginate the KV table by key prefix.
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await bill
      .from(KV).select("key, value")
      .like("key", `${prefix}%`)
      .range(from, from + 999);
    if (error) throw new Error(`kv ${prefix}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data.map((r) => r.value));
    if (data.length < 1000) break;
  }
  return out;
}

async function platAll(table: string, cols: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await plat.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  // ── da-billing side ────────────────────────────────────────────────────────
  const customers = await kvByPrefix("customer:");
  const templates = await kvByPrefix("template:");

  // ClientID lives in template line items as "<clientId>::<name>". Map customerId → clientId.
  const clientIdByCustomer = new Map<string, string>();
  for (const t of templates) {
    const prods: any[] = t?.products ?? [];
    for (const p of prods) {
      const m = String(p?.lineItemDescription ?? "").match(/^([^:]+)::/);
      if (m) { clientIdByCustomer.set(t.customerId, m[1].trim()); break; }
    }
  }

  const custById = new Map<string, any>(customers.map((c) => [c.id, c]));
  const byEmail = new Map<string, any>();
  const byCompanyName = new Map<string, any>();
  const byClientId = new Map<string, any>();
  for (const c of customers) {
    if (c.email) byEmail.set(norm(c.email), c);
    if (c.company) byCompanyName.set(norm(c.company), c);
    if (c.name) byCompanyName.set(norm(c.name), c);
    const cid = clientIdByCustomer.get(c.id);
    if (cid) byClientId.set(String(cid), c);
  }

  // ── platform side ────────────────────────────────────────────────────────
  const groups = await platAll("groups", "*");
  const dealers = await platAll("dealers", "*");
  console.log("Schema — groups cols:", Object.keys(groups[0] ?? {}).join(", "));
  console.log("Schema — dealers cols:", Object.keys(dealers[0] ?? {}).join(", "));
  console.log(`\nda-billing: ${customers.length} customers (${customers.filter(c=>!c.archived).length} active), ${templates.length} templates, ${byClientId.size} with a parsed ClientID`);
  console.log(`platform: ${groups.length} groups, ${dealers.length} dealers\n`);

  // ── Match-key probe: test every candidate key independently, with collision
  //    counts (a key is only safe to backfill on if it's near-unique). ────────
  const emailOf = (kind: string, e: any) => (kind === "dealer" ? e.primary_contact_email : (e.billing_email ?? e.email)) || null;
  const platEntities = [
    ...groups.map((g) => ({ kind: "group" as const, e: g })),
    ...dealers.map((d) => ({ kind: "dealer" as const, e: d })),
  ];
  const candidateKeys: Record<string, (x: { kind: string; e: any }) => any> = {
    "billing_customer_id→id": ({ e }) => (e.billing_customer_id && custById.has(e.billing_customer_id) ? e.billing_customer_id : null),
    "template_id→id":         ({ e }) => (e.template_id && custById.has(e.template_id) ? e.template_id : null),
    "billing_id→id(uuid)":    ({ e }) => (e.billing_id && custById.has(e.billing_id) ? e.billing_id : null),
    "billing_id→ClientID":    ({ e }) => (e.billing_id != null && byClientId.has(String(e.billing_id)) ? byClientId.get(String(e.billing_id)).id : null),
    "internal_id→ClientID":   ({ e }) => (e.internal_id != null && byClientId.has(String(e.internal_id)) ? byClientId.get(String(e.internal_id)).id : null),
    "legacy_id→ClientID":     ({ e }) => (e.legacy_id != null && byClientId.has(String(e.legacy_id)) ? byClientId.get(String(e.legacy_id)).id : null),
    "email":                  (x) => { const m = byEmail.get(norm(emailOf(x.kind, x.e))); return m ? m.id : null; },
    "name/company":           (x) => { const m = byCompanyName.get(norm(x.e.name)); return m ? m.id : null; },
  };
  console.log("\n=== Match-key probe (hits = platform entities matched; collisions = da-billing customers claimed by >1 platform entity) ===");
  for (const [label, fn] of Object.entries(candidateKeys)) {
    const billCounts = new Map<string, number>();
    let hits = 0;
    for (const x of platEntities) { const id = fn(x); if (id) { hits++; billCounts.set(id, (billCounts.get(id) ?? 0) + 1); } }
    const collisions = Array.from(billCounts.values()).filter((n) => n > 1).length;
    console.log(`  ${label.padEnd(24)} hits ${String(hits).padStart(4)}/${platEntities.length}  (${((hits/platEntities.length)*100).toFixed(1)}%)  | da-billing customers claimed >1×: ${collisions}`);
  }

  // Raw id-field dump for known accounts (where does ClientID 297 live?).
  for (const nm of ["dealer general", "h&h automotive"]) {
    const hit = platEntities.find((x) => norm(x.e.name) === norm(nm) || norm(x.e.name).includes(norm(nm)));
    if (hit) console.log(`\n[ids] ${hit.e.name}:`, { internal_id: hit.e.internal_id, legacy_id: hit.e.legacy_id, billing_id: hit.e.billing_id, template_id: hit.e.template_id, billing_customer_id: hit.e.billing_customer_id });
  }

  // Primary backfill key = platform billing_id == da-billing customer.id (UUID),
  // confirmed exact + near-unique by the probe above. email/name are recorded only
  // as soft signals (NOT used for backfill — too many collisions).
  // billing_id collisions (same da customer claimed by >1 platform entity) → flag.
  const billingIdCount = new Map<string, number>();
  for (const e of [...groups, ...dealers]) {
    if (e.billing_id && custById.has(e.billing_id)) billingIdCount.set(e.billing_id, (billingIdCount.get(e.billing_id) ?? 0) + 1);
  }

  type Cat = "synced" | "link-missing" | "link-missing-collision" | "genuinely-new" | "mismatch-orphan";
  const rows: any[] = [];

  function classify(kind: "group" | "dealer", e: any) {
    const pid = e.id;
    const link = e.billing_customer_id as string | null;
    const billingId = e.billing_id as string | null;
    const email = kind === "dealer" ? e.primary_contact_email : (e.billing_email ?? e.email);
    const name = e.name;
    const createdAt = e.created_at ?? null;

    const linkCust = link && custById.has(link) ? custById.get(link) : null;
    const billCust = billingId && custById.has(billingId) ? custById.get(billingId) : null;
    const mEmail = email && byEmail.has(norm(email)) ? byEmail.get(norm(email)) : null;
    const mName = name && byCompanyName.has(norm(name)) ? byCompanyName.get(norm(name)) : null;

    let cat: Cat;
    let matchKey = "";
    let matched = "";
    if (link) {
      cat = linkCust ? "synced" : "mismatch-orphan";
      matchKey = linkCust ? "billing_customer_id" : "";
      matched = link;
    } else if (billCust) {
      const collides = (billingIdCount.get(billingId!) ?? 0) > 1;
      cat = collides ? "link-missing-collision" : "link-missing";
      matchKey = "billing_id";
      matched = billingId!;
    } else {
      cat = "genuinely-new";
      matched = "";
    }

    rows.push({
      kind, name, platform_id: pid, internal_id: e.internal_id ?? "", billing_id: billingId ?? "",
      billing_customer_id: link ?? "", matched_dabilling_id: matched,
      da_client_id: clientIdByCustomer.get(matched) ?? "", email: email ?? "",
      soft_email_match: mEmail?.id ?? "", soft_name_match: mName?.id ?? "",
      category: cat, match_key: matchKey, account_type: e.account_type ?? "", created_at: createdAt ?? "",
    });
  }

  groups.forEach((g) => classify("group", g));
  dealers.forEach((d) => classify("dealer", d));

  const tally = (kind: string) => {
    const r = rows.filter((x) => kind === "all" || x.kind === kind);
    const c = (k: string) => r.filter((x) => x.category === k).length;
    // genuinely-new split: does a soft email/name signal exist (worth manual review) or none?
    const newRows = r.filter((x) => x.category === "genuinely-new");
    return {
      total: r.length, synced: c("synced"),
      linkMissing_billingId: c("link-missing"), linkMissing_collision: c("link-missing-collision"),
      new_noMatch: newRows.filter((x) => !x.soft_email_match && !x.soft_name_match).length,
      new_softSignal: newRows.filter((x) => x.soft_email_match || x.soft_name_match).length,
      mismatch: c("mismatch-orphan"),
    };
  };

  console.log("\n=== Categories (primary key = billing_id → da-billing customer.id) ===");
  for (const k of ["group", "dealer", "all"]) console.table({ [k]: tally(k) });

  // orphans: active da-billing customers not linked by any platform billing_id
  const matchedBillIds = new Set(rows.map((r) => r.matched_dabilling_id).filter(Boolean));
  const orphanCustomers = customers.filter((c) => !c.archived && !matchedBillIds.has(c.id));
  console.log(`\nactive da-billing customers NOT linked from any platform billing_id: ${orphanCustomers.length} (of ${customers.filter(c=>!c.archived).length} active) — expected (member dealers bill via group template + zombies)`);

  // billing_id collisions (must be resolved manually before backfill)
  const collisionRows = rows.filter((r) => r.category === "link-missing-collision");
  console.log(`\nbilling_id COLLISIONS (>1 platform entity → same da customer): ${collisionRows.length}`);
  for (const r of collisionRows) console.log(`   ${r.kind} "${r.name}" (${r.platform_id}) → ${r.matched_dabilling_id}`);

  // Dealer General spotlight
  const dg = rows.find((r) => norm(r.name).includes("dealergeneral"));
  console.log("\n=== Dealer General ===", dg ?? "(not found)");

  // CSV (gitignored: *.csv)
  const headers = ["kind","name","platform_id","internal_id","billing_id","billing_customer_id","matched_dabilling_id","da_client_id","email","soft_email_match","soft_name_match","category","match_key","account_type","created_at"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../billing-link-audit.csv", import.meta.url), csv);
  console.log("\nCSV → da-platform/billing-link-audit.csv (gitignored)");
})().catch((e) => { console.error(e); process.exit(1); });
