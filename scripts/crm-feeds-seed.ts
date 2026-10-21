/**
 * crm-feeds-seed.ts — DA-CRM Phase 2b seed. DRY RUN unless --apply. Idempotent.
 *
 *  • Feed suppliers (crm_companies kind feed_supplier + crm_feed_supplier_settings)
 *    for every provider in lib/inventory-providers.ts plus the vendors seen in
 *    support@'s own "Inventory Feed Request for: …" emails (2026):
 *      ready (needs_review = false) — request addresses used on 3+ sent requests:
 *        Vauto (vat.support@ + vat.exports@coxautoinc.com, Feed IDs "MP…"),
 *        Team Velocity (support@teamvelocitymarketing.com), DealerOn (help@dealeron.com)
 *      address seen, needs review — DealerInspire, DealerDotCom, Firstlook (Max Digital),
 *        Advent, Reynolds, Vincue, VinSolutions
 *      CDK, Tekion — request_method 'api' (their own order systems)
 *      everything else — no address yet, needs review
 *    Existing settings are never overwritten (only filled where blank).
 *  • Global "Feed requests" templates (one per kind) from lib/crm/feeds/templates.ts,
 *    when the kind has no global template yet.
 *
 *   npm run crm:feeds-seed            dry run
 *   npm run crm:feeds-seed -- --apply
 */
import { createClient } from "@supabase/supabase-js";
import { DMS_PROVIDERS, OTHER_PROVIDERS } from "../lib/inventory-providers";
import { DEFAULT_FEED_TEMPLATES, FEED_KINDS, FEED_CATEGORY } from "../lib/crm/feeds/templates";
import { sanitizeTemplateHtml } from "../lib/crm/email-html";
import { derived } from "../lib/crm/templates";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();
/* eslint-disable @typescript-eslint/no-explicit-any */
const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log(APPLY ? "" : "[dry-run]", ...a);

type Seed = { name: string; request_email?: string; cc?: string[]; method?: "email" | "pdf" | "api"; pattern?: string; ready?: boolean; note?: string };
const KNOWN: Seed[] = [
  { name: "Vauto", request_email: "vat.support@coxautoinc.com", cc: ["vat.exports@coxautoinc.com"], pattern: "\\b(MP\\d{3,6})\\b", ready: true, note: "31 + 27 sent requests (support@ Sent Items, 2026). Replies: \"Feed ID: MP6767\", \"enabled this feed under ID: MP12601\"." },
  { name: "Team Velocity", request_email: "support@teamvelocitymarketing.com", ready: true, note: "Team Velocity sends its own \"DEALER APPROVAL REQUIRED — Reply All with APPROVED\" email to the dealer." },
  { name: "DealerOn", request_email: "help@dealeron.com", ready: true, note: "Replies come from a case system (\"Case Number: …\") and close after 48h without a response." },
  { name: "DealerInspire", request_email: "support@dealerinspire.com", note: "Reply seen: \"enabled the inventory export under the ID: OxmoorHyundai\"." },
  { name: "DealerDotCom", request_email: "support@dealer.com" },
  { name: "Firstlook", request_email: "helpdesk@maxdigital.com", note: "Max Digital / ACV MAX. Replies: \"under the ID LITHIAVW01\"." },
  { name: "Advent", request_email: "support@adventresources.com" },
  { name: "Reynolds", request_email: "datasupport@reyrey.com", note: "Check whether Reynolds needs a signed PDF (CARS Act requests, 2026)." },
  { name: "Vincue", request_email: "support@dealercue.com" },
  { name: "VinSolutions", request_email: "support@vinsolutions.com" },
  { name: "CDK", method: "api", note: "Proprietary order system — order in CDK's portal, then Mark as sent." },
  { name: "Tekion", method: "api", note: "Proprietary order system — order in Tekion's portal, then Mark as sent." },
];

async function main() {
  const admin: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const names = Array.from(new Set([...DMS_PROVIDERS, ...OTHER_PROVIDERS, ...KNOWN.map((k) => k.name)])).sort((a, b) => a.localeCompare(b));
  const { data: existing } = await admin.from("crm_companies").select("id, name").eq("kind", "feed_supplier");
  const byName = new Map<string, string>((existing ?? []).map((c: any) => [String(c.name).toLowerCase(), c.id]));
  const { data: settingsRows } = await admin.from("crm_feed_supplier_settings").select("*");
  const settings = new Map<string, any>((settingsRows ?? []).map((s: any) => [s.company_id, s]));

  console.log("── feed suppliers ──");
  let created = 0, filled = 0;
  for (const name of names) {
    const k = KNOWN.find((x) => x.name.toLowerCase() === name.toLowerCase());
    let id = byName.get(name.toLowerCase());
    if (!id) {
      created++;
      log(`add supplier ${name}${k?.request_email ? ` <${k.request_email}>` : ""}${k?.method === "api" ? " (portal)" : ""}${k?.ready ? " · ready" : " · needs review"}`);
      if (!APPLY) continue;
      const { data, error } = await admin.from("crm_companies").insert({ kind: "feed_supplier", name }).select("id").single();
      if (error) { console.error(`  ${name}: ${error.message}`); continue; }
      id = data.id;
    }
    const cur = settings.get(id!);
    const want = {
      request_method: k?.method ?? "email", request_email: k?.request_email ?? null, cc_emails: k?.cc ?? [],
      feed_id_pattern: k?.pattern ?? null, platform_provider: name, is_dms: DMS_PROVIDERS.includes(name), needs_review: !k?.ready, notes: k?.note ?? null,
    };
    if (!cur) {
      if (byName.has(name.toLowerCase())) log(`settings for ${name}`);
      if (APPLY) { const { error } = await admin.from("crm_feed_supplier_settings").insert({ company_id: id, ...want }); if (error) console.error(`  ${name} settings: ${error.message}`); }
      continue;
    }
    // Fill blanks only.
    const patch: Record<string, unknown> = {};
    if (!cur.request_email && want.request_email) patch.request_email = want.request_email;
    if (!(cur.cc_emails ?? []).length && want.cc_emails.length) patch.cc_emails = want.cc_emails;
    if (!cur.feed_id_pattern && want.feed_id_pattern) patch.feed_id_pattern = want.feed_id_pattern;
    if (!cur.platform_provider) patch.platform_provider = want.platform_provider;
    if (!cur.notes && want.notes) patch.notes = want.notes;
    if (Object.keys(patch).length) {
      filled++;
      log(`fill ${name}: ${Object.keys(patch).join(", ")}`);
      if (APPLY) await admin.from("crm_feed_supplier_settings").update(patch).eq("company_id", id);
    }
  }
  console.log(`${created} supplier(s) to add, ${filled} to fill in`);

  console.log("── Feed requests templates (global defaults) ──");
  const { data: tpls } = await admin.from("crm_email_templates").select("feed_kind, supplier_company_id, archived").not("feed_kind", "is", null);
  for (const kind of FEED_KINDS) {
    if ((tpls ?? []).some((t: any) => t.feed_kind === kind && !t.supplier_company_id && !t.archived)) { log(`${kind}: already has a global template`); continue; }
    const t = DEFAULT_FEED_TEMPLATES[kind];
    const body = sanitizeTemplateHtml(t.body_html);
    const d = derived(t.subject, body);
    log(`add template "${t.name}" (${kind})${d.unknown.length ? ` — UNKNOWN TOKENS ${d.unknown.join(", ")}` : ""}`);
    if (APPLY) {
      const { error } = await admin.from("crm_email_templates").insert({ name: t.name, category: FEED_CATEGORY, subject: t.subject, body_html: body, variables: d.variables, needs_review: d.needs_review, feed_kind: kind, source: "manual" });
      if (error) console.error(`  ${kind}: ${error.message}`);
    }
  }
  if (!APPLY) console.log("\ndry run — nothing written (add --apply)");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
