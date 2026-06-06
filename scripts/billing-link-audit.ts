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

  // candidate platform "client id" fields (FreshBooks/Aurora legacy)
  const platClientId = (e: any) =>
    e.internal_id ?? e.legacy_id ?? e.legacy_group_id ?? e.aurora_id ?? e.freshbooks_id ?? null;

  type Cat = "synced" | "link-missing" | "genuinely-new" | "mismatch-orphan";
  const rows: any[] = [];
  const keyHits = { link: 0, clientId: 0, email: 0, name: 0 };

  function classify(kind: "group" | "dealer", e: any) {
    const pid = e.id;
    const cid = platClientId(e);
    const link = e.billing_customer_id as string | null;
    const email = kind === "dealer" ? e.primary_contact_email : (e.billing_email ?? e.email);
    const name = e.name;
    const createdAt = e.created_at ?? null;

    // match by each key independently (for match-rate reporting)
    const mLink = link && custById.has(link) ? custById.get(link) : null;
    const mClient = cid != null && byClientId.has(String(cid)) ? byClientId.get(String(cid)) : null;
    const mEmail = email && byEmail.has(norm(email)) ? byEmail.get(norm(email)) : null;
    const mName = name && byCompanyName.has(norm(name)) ? byCompanyName.get(norm(name)) : null;
    if (mLink) keyHits.link++;
    if (mClient) keyHits.clientId++;
    if (mEmail) keyHits.email++;
    if (mName) keyHits.name++;

    // best match for backfill (priority: clientId > email > name)
    const best = mClient ?? mEmail ?? mName ?? null;
    const matchKey = mClient ? "clientId" : mEmail ? "email" : mName ? "name" : "";

    let cat: Cat;
    if (link) cat = mLink ? "synced" : "mismatch-orphan";
    else if (best) cat = "link-missing";
    else cat = "genuinely-new";

    rows.push({
      kind, name, platform_id: pid, client_id: cid ?? "", billing_customer_id: link ?? "",
      matched_dabilling_id: (mLink ?? best)?.id ?? "", da_client_id: clientIdByCustomer.get((mLink ?? best)?.id) ?? "",
      email: email ?? "", category: cat, match_key: link ? (mLink ? "link" : "") : matchKey, created_at: createdAt ?? "",
    });
  }

  groups.forEach((g) => classify("group", g));
  dealers.forEach((d) => classify("dealer", d));

  const tally = (kind: string) => {
    const r = rows.filter((x) => kind === "all" || x.kind === kind);
    const c = (k: string) => r.filter((x) => x.category === k).length;
    return { total: r.length, synced: c("synced"), linkMissing: c("link-missing"), new: c("genuinely-new"), mismatch: c("mismatch-orphan") };
  };

  console.log("=== Categories ===");
  for (const k of ["group", "dealer", "all"]) console.table({ [k]: tally(k) });

  console.log("\n=== Match rate per key (platform entities resolving to a da-billing customer) ===");
  const N = rows.length;
  for (const [k, v] of Object.entries(keyHits)) console.log(`  ${k.padEnd(10)} ${v}/${N}  (${((v / N) * 100).toFixed(1)}%)`);

  // orphans: da-billing customers with no platform match by any key
  const matchedBillIds = new Set(rows.map((r) => r.matched_dabilling_id).filter(Boolean));
  const orphanCustomers = customers.filter((c) => !c.archived && !matchedBillIds.has(c.id));
  console.log(`\nda-billing active customers with NO platform match: ${orphanCustomers.length}`);

  // Dealer General spotlight
  const dg = rows.find((r) => norm(r.name).includes("dealergeneral"));
  console.log("\n=== Dealer General ===", dg ?? "(not found by name)");
  const dgCust = customers.find((c) => norm(c.company).includes("dealergeneral") || norm(c.name).includes("dealergeneral"));
  if (dgCust) console.log("  da-billing customer:", { id: dgCust.id, company: dgCust.company, clientId: clientIdByCustomer.get(dgCust.id), discount: dgCust.subscriptionDiscount, archived: dgCust.archived });

  // CSV (gitignored: *.csv)
  const headers = ["kind","name","platform_id","client_id","billing_customer_id","matched_dabilling_id","da_client_id","email","category","match_key","created_at"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../billing-link-audit.csv", import.meta.url), csv);
  console.log("\nCSV → da-platform/billing-link-audit.csv (gitignored)");
})().catch((e) => { console.error(e); process.exit(1); });
