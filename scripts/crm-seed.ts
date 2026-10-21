/**
 * crm-seed.ts — DA-CRM Phase 1 back-fill + seed. DRY RUN unless --apply.
 * Every section is idempotent and safe to re-run.
 *
 *   npm run crm:seed -- --companies   one crm_companies row per dealer and group
 *                                     (fills any the migration / triggers missed),
 *                                     dealer stage from the platform's own
 *                                     isPayingAccount / isTrialAccountType rules
 *                                     (only rows created here, or all with --restage),
 *                                     brands from dealers.makes where a dealer has none
 *   npm run crm:seed -- --staff       crm_staff_profiles for the current team
 *   npm run crm:seed -- --contacts    a few test contacts from existing dealer users
 *   npm run crm:seed -- --fixtures    2–3 test vendors + feed suppliers ("[test fixture]")
 *   npm run crm:seed -- --all         all of the above
 *   … add --apply to write.
 */
import { createClient } from "@supabase/supabase-js";
import { isPayingAccount } from "../lib/hubspot";
import { isTrialAccountType } from "../lib/print-eligibility";
import { normalizePhone } from "../lib/crm/phone";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();

/* eslint-disable @typescript-eslint/no-explicit-any */
const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const ALL = args.has("--all");
const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const log = (...a: unknown[]) => console.log(APPLY ? "" : "[dry-run]", ...a);

async function pageAll(table: string, columns: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** Platform account state → DA-CRM pipeline stage. */
export function stageFor(d: { active: boolean; account_type: string | null; downgraded_at: string | null }): string {
  if (!d.active) return "cancelled";
  if (isTrialAccountType(d.account_type) && !d.downgraded_at) return "trial";
  if (isPayingAccount(d.account_type)) return "paying";
  return "cancelled";
}

// Feed makes are dirty ("CHEVY", "VW", "MINI COOPER", "Land Rover ").
const BRAND_ALIASES: Record<string, string> = {
  chevy: "Chevrolet", vw: "Volkswagen", "mini cooper": "MINI", mercedes: "Mercedes-Benz", "mercedes benz": "Mercedes-Benz",
  infinity: "INFINITI", landrover: "Land Rover", "range rover": "Land Rover", alfa: "Alfa Romeo", "ram trucks": "RAM",
  "harley davidson": "Harley-Davidson", "rolls royce": "Rolls-Royce", "can am": "Can-Am",
};

async function companies() {
  console.log("\n── companies ──");
  const [dealers, groups, existing, brands, haveBrands] = await Promise.all([
    pageAll("dealers", "id, active, phone, account_type, downgraded_at, created_at, hubspot_company_id, makes"),
    pageAll("groups", "id, phone, hubspot_company_id"),
    pageAll("crm_companies", "id, kind, dealer_id, group_id, pipeline_stage"),
    pageAll("crm_brands", "brand"),
    pageAll("crm_company_brands", "company_id"),
  ]);
  const byDealer = new Map(existing.filter((c) => c.dealer_id).map((c) => [c.dealer_id, c]));
  const byGroup = new Set(existing.filter((c) => c.group_id).map((c) => c.group_id));

  const newDealers = dealers.filter((d) => !byDealer.has(d.id)).map((d) => {
    const stage = stageFor(d);
    return {
      kind: "dealer", dealer_id: d.id, phone: normalizePhone(d.phone), pipeline_stage: stage, stage_changed_at: new Date().toISOString(),
      trial_started_at: stage === "trial" ? d.created_at : null, hubspot_company_id: d.hubspot_company_id || null,
    };
  });
  const newGroups = groups.filter((g) => !byGroup.has(g.id)).map((g) => ({
    kind: "group", group_id: g.id, phone: normalizePhone(g.phone), hubspot_company_id: g.hubspot_company_id || null,
  }));
  log(`dealers ${dealers.length} · groups ${groups.length} · existing companies ${existing.length}`);
  log(`missing: ${newDealers.length} dealer rows, ${newGroups.length} group rows`);
  if (APPLY) {
    for (let i = 0; i < newDealers.length; i += 500) {
      const { error } = await admin.from("crm_companies").upsert(newDealers.slice(i, i + 500), { onConflict: "dealer_id", ignoreDuplicates: true });
      if (error) throw new Error(`insert dealers: ${error.message}`);
    }
    if (newGroups.length) {
      const { error } = await admin.from("crm_companies").upsert(newGroups, { onConflict: "group_id", ignoreDuplicates: true });
      if (error) throw new Error(`insert groups: ${error.message}`);
    }
  }

  // Re-derive stage with the app's rules (the migration's SQL CASE is an approximation).
  if (args.has("--restage")) {
    let changed = 0;
    const dealerById = new Map(dealers.map((d) => [d.id, d]));
    for (const c of existing.filter((x) => x.kind === "dealer")) {
      const d = dealerById.get(c.dealer_id);
      if (!d) continue;
      const stage = stageFor(d);
      // Only correct the automatic stages; a staff-set setup_training / lost stays.
      if (c.pipeline_stage === stage || c.pipeline_stage === "setup_training" || c.pipeline_stage === "lost") continue;
      changed++;
      if (APPLY) await admin.from("crm_companies").update({
        pipeline_stage: stage, trial_started_at: stage === "trial" ? d.created_at : null, trial_day: null, trial_flag: null, trial_ends_on: null,
      }).eq("id", c.id);
    }
    log(`restage: ${changed} dealer stages corrected`);
  }

  // Brands from dealers.makes, only for dealers with no CRM brands yet.
  const canon = new Map(brands.map((b) => [b.brand.toLowerCase(), b.brand]));
  const hasBrands = new Set(haveBrands.map((b) => b.company_id));
  const { data: dealerCompanies } = { data: await pageAll("crm_companies", "id, dealer_id") };
  const companyOfDealer = new Map(dealerCompanies.filter((c: any) => c.dealer_id).map((c: any) => [c.dealer_id, c.id]));
  const rows: { company_id: string; brand: string }[] = [];
  const unknown = new Map<string, number>();
  for (const d of dealers) {
    const cid = companyOfDealer.get(d.id);
    if (!cid || hasBrands.has(cid) || !Array.isArray(d.makes)) continue;
    const set = new Set<string>();
    for (const raw of d.makes) {
      const k = String(raw ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
      if (!k) continue;
      const b = canon.get(k) ?? BRAND_ALIASES[k] ?? canon.get(k.replace(/ /g, "-"));
      if (b) set.add(b); else unknown.set(k, (unknown.get(k) ?? 0) + 1);
    }
    for (const brand of Array.from(set)) rows.push({ company_id: cid as string, brand });
  }
  log(`brands: ${rows.length} dealer-brand links from dealers.makes`);
  if (unknown.size) log(`unmapped makes (top 15): ${Array.from(unknown.entries()).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, n]) => `${k}×${n}`).join(", ")}`);
  if (APPLY) for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("crm_company_brands").upsert(rows.slice(i, i + 500), { onConflict: "company_id,brand", ignoreDuplicates: true });
    if (error) throw new Error(`brands: ${error.message}`);
  }
}

// Current team (CLAUDE.md "WHO YOU ARE WORKING WITH" + migration 088's list).
// Team / capabilities are best guesses — adjust on the Team page.
const TEAM: { email: string; team: "customer_support" | "management"; capabilities: string[] }[] = [
  { email: "allan@dealeraddendums.com", team: "management", capabilities: ["tier2", "feed_support", "ar_ap"] },
  { email: "alex@dealeraddendums.com", team: "management", capabilities: ["tier1", "tier2"] },
  { email: "marlena@dealeraddendums.com", team: "customer_support", capabilities: ["tier1"] },
  { email: "claire@dealeraddendums.com", team: "customer_support", capabilities: ["tier1"] },
  { email: "carol@dealeraddendums.com", team: "customer_support", capabilities: ["tier1"] },
];
const WEEKDAY_HOURS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { start: "08:00", end: "17:00" }]));

async function staff() {
  console.log("\n── staff ──");
  const { data: profiles } = await admin.from("profiles").select("id, email, full_name, role, active").in("email", TEAM.map((t) => t.email));
  for (const t of TEAM) {
    const p = (profiles ?? []).find((x: any) => x.email?.toLowerCase() === t.email);
    if (!p || p.role !== "super_admin") { log(`skip ${t.email}: no active super_admin profile`); continue; }
    log(`${t.email} → ${t.team} [${t.capabilities.join(", ")}]`);
    if (!APPLY) continue;
    await admin.from("staff_permissions").upsert({ user_id: p.id, permission: "crm" }, { onConflict: "user_id,permission", ignoreDuplicates: true });
    if (t.email === "allan@dealeraddendums.com") {
      await admin.from("staff_permissions").upsert({ user_id: p.id, permission: "crm_admin" }, { onConflict: "user_id,permission", ignoreDuplicates: true });
    }
    // ignoreDuplicates: never overwrite what someone already set on the Team page.
    const { error } = await admin.from("crm_staff_profiles").upsert({
      staff_id: p.id, full_name: p.full_name, team: t.team, capabilities: t.capabilities, work_hours: WEEKDAY_HOURS, time_zone: "America/Denver",
    }, { onConflict: "staff_id", ignoreDuplicates: true });
    if (error) console.error(`  ${t.email}: ${error.message}`);
  }
}

async function contacts() {
  console.log("\n── contacts ──");
  const { data: users } = await admin.from("profiles")
    .select("id, email, full_name, phone, dealer_id, role")
    .eq("role", "dealer_admin").eq("active", true).not("dealer_id", "is", null).not("email", "is", null)
    .order("last_login", { ascending: false, nullsFirst: false }).limit(5);
  for (const u of users ?? []) {
    const { data: d } = await admin.from("dealers").select("id, name").eq("dealer_id", u.dealer_id).maybeSingle();
    if (!d) continue;
    const { data: c } = await admin.from("crm_companies").select("id").eq("dealer_id", d.id).maybeSingle();
    if (!c) { log(`skip ${u.email}: dealer ${d.name} has no company row (run --companies)`); continue; }
    const [first, ...rest] = String(u.full_name ?? "").trim().split(/\s+/);
    log(`${u.email} → ${d.name}`);
    if (!APPLY) continue;
    const { error } = await admin.from("crm_contacts").insert({
      company_id: c.id, user_id: u.id, first_name: first || u.email.split("@")[0], last_name: rest.join(" ") || null,
      email: u.email.toLowerCase(), phone: normalizePhone(u.phone), role_tag: "admin", source: "seed",
    });
    if (error && error.code !== "23505") console.error(`  ${u.email}: ${error.message}`);
  }
}

// Clearly-labelled test partners; .example.com addresses never route anywhere.
const FIXTURES = [
  { kind: "vendor", name: "Sample Label Supply Co. [test fixture]", website: "https://labels.example.com", phone: "(801) 555-0140",
    emails: [{ address: "orders@labels.example.com", label: "Orders" }], notes: "Test fixture — paper / label supplier. Safe to delete." },
  { kind: "vendor", name: "Sample Dealer Association [test fixture]", website: "https://association.example.com", phone: null,
    emails: [{ address: "info@association.example.com", label: "Main" }], notes: "Test fixture — association. Safe to delete." },
  { kind: "vendor", name: "Sample DMS Software [test fixture]", website: "https://dms.example.com", phone: "(801) 555-0142",
    emails: [{ address: "partners@dms.example.com", label: "Partners" }], notes: "Test fixture — software vendor. Safe to delete." },
  { kind: "feed_supplier", name: "Sample Inventory Feed Co. [test fixture]", website: "https://feeds.example.com", phone: "(801) 555-0150",
    emails: [{ address: "support@feeds.example.com", label: "Support" }], notes: "Test fixture — inventory feed (FTP). Safe to delete." },
  { kind: "feed_supplier", name: "Sample Listings API [test fixture]", website: "https://api.listings.example.com", phone: null,
    emails: [{ address: "api@listings.example.com", label: "API support" }], notes: "Test fixture — inventory API. Safe to delete." },
];

async function fixtures() {
  console.log("\n── fixtures ──");
  for (const f of FIXTURES) {
    const { data: have } = await admin.from("crm_companies").select("id").eq("name", f.name).maybeSingle();
    if (have) { log(`exists: ${f.name}`); continue; }
    log(`add ${f.kind}: ${f.name}`);
    if (!APPLY) continue;
    const { error } = await admin.from("crm_companies").insert({ ...f, phone: normalizePhone(f.phone) });
    if (error) console.error(`  ${f.name}: ${error.message}`);
  }
}

async function main() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  if (ALL || args.has("--companies")) await companies();
  if (ALL || args.has("--staff")) await staff();
  if (ALL || args.has("--contacts")) await contacts();
  if (ALL || args.has("--fixtures")) await fixtures();
  if (!Array.from(args).some((a) => ["--all", "--companies", "--staff", "--contacts", "--fixtures"].includes(a))) {
    console.log("Pick a section: --companies --staff --contacts --fixtures or --all (add --apply to write).");
  }
  console.log(APPLY ? "\ndone" : "\ndry run — nothing written (add --apply)");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
