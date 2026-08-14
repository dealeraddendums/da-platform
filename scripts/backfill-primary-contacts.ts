/**
 * One-time backfill: create/adopt + associate HubSpot Contacts for every
 * dealer's PRIMARY CONTACT (2026-08-14). Companion to the go-forward fix in
 * lib/sync-hubspot.ts syncDealerPrimaryContact — this script calls THAT
 * function per dealer (no forked logic), so create/adopt-by-email semantics,
 * createOnly properties, idempotent v4 association, id storage, and
 * hubspot_sync_errors logging are identical to the live path.
 *
 * Run on the da-platform box from the app root:
 *   DRY_RUN=1 npx tsx scripts/backfill-primary-contacts.ts      # classify only
 *   npx tsx scripts/backfill-primary-contacts.ts                # live
 * Options:
 *   ONLY_DEALER_IDS_FILE=/path/ids.txt   scope to listed dealer_id values
 *   INCLUDE_INACTIVE=1                   include inactive dealers (default: active only)
 *
 * Scope: active dealers with a HubSpot company id + contact email, excluding
 * test/demo/QA accounts (same spirit as the July company backfill).
 * Idempotent + resumable: already-linked dealers (hubspot_primary_contact_id
 * set) are skipped; adoption is by email so shared contacts (AutoNation
 * pattern) get ONE Contact associated to each company.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync, existsSync } from "fs";

// Load env BEFORE importing lib code (lib/db reads process.env lazily, but
// keep the order deterministic). Box path first, local fallback.
for (const p of ["/var/www/da-platform/shared/.env.production", ".env.production", ".env.local"]) {
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    console.log(`env loaded from ${p}`);
    break;
  }
}

const DRY = process.env.DRY_RUN === "1";
const INCLUDE_INACTIVE = process.env.INCLUDE_INACTIVE === "1";
const TEST_NAME_RE = /\b(test|qa|demo|sample)\b/i;
const TEST_EMAIL_RE = /@test\.|@example\.|^demo@|^qa[-_.]/i;

type Row = {
  id: string; dealer_id: string; name: string | null; active: boolean;
  primary_contact: string | null; primary_contact_email: string | null;
  phone: string | null; hubspot_company_id: string | null;
  hubspot_primary_contact_id: string | null;
};

async function main() {
  const { createAdminSupabaseClient } = await import("../lib/db");
  const { syncDealerPrimaryContact } = await import("../lib/sync-hubspot");
  const admin = createAdminSupabaseClient();
  const HS = process.env.HUBSPOT_PRIVATE_APP_TOKEN!;

  // Optional scoping file (one dealer_id per line), like the July backfill.
  let onlyIds: Set<string> | null = null;
  if (process.env.ONLY_DEALER_IDS_FILE) {
    onlyIds = new Set(readFileSync(process.env.ONLY_DEALER_IDS_FILE, "utf8").split("\n").map(s => s.trim()).filter(Boolean));
    console.log(`scoped to ${onlyIds.size} dealer_ids from file`);
  }

  // Page past the PostgREST 1000-row clamp.
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    let q = (admin as any).from("dealers")
      .select("id, dealer_id, name, active, primary_contact, primary_contact_email, phone, hubspot_company_id, hubspot_primary_contact_id")
      .order("dealer_id").range(from, from + 999);
    if (!INCLUDE_INACTIVE) q = q.eq("active", true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  console.log(`${rows.length} ${INCLUDE_INACTIVE ? "total" : "active"} dealers loaded`);

  // Inactive count for Allan (same open question as the July backfill).
  if (!INCLUDE_INACTIVE) {
    const { count } = await (admin as any).from("dealers")
      .select("id", { count: "exact", head: true })
      .eq("active", false).not("hubspot_company_id", "is", null).not("primary_contact_email", "is", null);
    console.log(`(inactive dealers with company id + contact email, NOT processed: ${count ?? 0})`);
  }

  // Classify.
  const skipped: Record<string, number> = { "no-email": 0, "no-company-id": 0, test: 0, "not-in-scope-file": 0 };
  const alreadyLinked: Row[] = [];
  const candidates: Row[] = [];
  for (const d of rows) {
    if (onlyIds && !onlyIds.has(d.dealer_id)) { skipped["not-in-scope-file"]++; continue; }
    const email = (d.primary_contact_email ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) { skipped["no-email"]++; continue; }
    if (!d.hubspot_company_id) { skipped["no-company-id"]++; continue; }
    if (TEST_NAME_RE.test(d.name ?? "") || TEST_EMAIL_RE.test(email) || d.dealer_id.startsWith("qa-")) { skipped.test++; continue; }
    if (d.hubspot_primary_contact_id) { alreadyLinked.push(d); continue; }
    candidates.push(d);
  }

  // need-create vs need-adopt: batch-read HubSpot contacts by email (100/call).
  const emails = Array.from(new Set(candidates.map(d => d.primary_contact_email!.trim().toLowerCase())));
  const existing = new Set<string>();
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    const r = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      headers: { Authorization: `Bearer ${HS}`, "Content-Type": "application/json" },
      body: JSON.stringify({ idProperty: "email", inputs: batch.map(id => ({ id })), properties: ["email"] }),
    });
    const j = await r.json().catch(() => null) as any;
    for (const res of j?.results ?? []) existing.add(String(res.properties?.email ?? "").toLowerCase());
    await new Promise(res => setTimeout(res, 250));
  }
  const needAdopt = candidates.filter(d => existing.has(d.primary_contact_email!.trim().toLowerCase()));
  const needCreate = candidates.filter(d => !existing.has(d.primary_contact_email!.trim().toLowerCase()));

  // Shared-email fan-out (one contact → many companies).
  const emailFan = new Map<string, number>();
  for (const d of candidates) {
    const e = d.primary_contact_email!.trim().toLowerCase();
    emailFan.set(e, (emailFan.get(e) ?? 0) + 1);
  }
  const shared = Array.from(emailFan.entries()).filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  // Shared HubSpot company ids among candidates (the 7/26 pair class).
  const companyFan = new Map<string, string[]>();
  for (const d of candidates) {
    const list = companyFan.get(d.hubspot_company_id!) ?? [];
    list.push(d.dealer_id);
    companyFan.set(d.hubspot_company_id!, list);
  }
  const sharedCompanies = Array.from(companyFan.entries()).filter(([, l]) => l.length > 1);

  console.log("\n=== CLASSIFICATION ===");
  console.log(`already-linked (skip): ${alreadyLinked.length}`);
  console.log(`need-CREATE: ${needCreate.length}`);
  console.log(`need-ADOPT (email already a HubSpot contact): ${needAdopt.length}`);
  console.log(`skipped: ${JSON.stringify(skipped)}`);
  console.log(`shared emails among candidates (fan-out >1): ${shared.length}${shared.length ? " — top: " + shared.slice(0, 6).map(([e, n]) => `${e}×${n}`).join(", ") : ""}`);
  console.log(`shared HubSpot company ids among candidates: ${sharedCompanies.length}${sharedCompanies.length ? " — " + sharedCompanies.slice(0, 5).map(([id, l]) => `${id}:[${l.join(",")}]`).join(" ") : ""}`);

  if (DRY) {
    console.log("\nDRY RUN — no writes. Samples:");
    for (const d of needCreate.slice(0, 5)) console.log(`  create: ${d.name} <${d.primary_contact_email}> (${d.primary_contact ?? "no name"})`);
    for (const d of needAdopt.slice(0, 5)) console.log(`  adopt:  ${d.name} <${d.primary_contact_email}>`);
    return;
  }

  console.log("\n=== LIVE RUN ===");
  const stats = { created: 0, adopted: 0, failed: 0, skipped: 0 };
  let n = 0;
  for (const d of candidates) {
    const res = await syncDealerPrimaryContact(admin, d as any, d.hubspot_company_id!);
    if ("failed" in res) { stats.failed++; console.log(`  FAIL ${d.dealer_id} ${d.primary_contact_email}`); }
    else if ("skipped" in res) stats.skipped++;
    else if (res.created) { stats.created++; }
    else { stats.adopted++; }
    if (++n % 50 === 0) console.log(`  …${n}/${candidates.length} (created ${stats.created}, adopted ${stats.adopted}, failed ${stats.failed})`);
    await new Promise(r => setTimeout(r, 300)); // ≤3 HubSpot calls per dealer → well under rate limits
  }
  console.log(`\nDONE: created ${stats.created}, adopted ${stats.adopted}, failed ${stats.failed}, fn-skipped ${stats.skipped}`);

  const { data: errs } = await (admin as any).from("hubspot_sync_errors")
    .select("object_id, error_message").eq("object_type", "contact")
    .gte("created_at", new Date(Date.now() - 3600e3).toISOString()).limit(10);
  console.log(`hubspot_sync_errors (contact, last hour): ${errs?.length ?? 0}${errs?.length ? " — " + JSON.stringify(errs.slice(0, 3)) : ""}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
