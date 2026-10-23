/**
 * crm-feeds-seed.ts — DA-CRM Phase 2b seed. DRY RUN unless --apply. Idempotent.
 *
 *  • Team Velocity, Vauto, Autosoft — lib/crm/feeds/suppliers.ts, from their real threads
 *    (support@, Oct 2026). AUTHORITATIVE: settings, per-supplier templates (folder
 *    "Feed requests · {supplier}") and Autosoft's blank Data Transfer Authorization PDF
 *    (uploaded to S3 as pdf_template_s3_key) are set to what the profile says; the dry
 *    run lists every field it would change.
 *  • Every other feed supplier (crm_companies kind feed_supplier + crm_feed_supplier_settings)
 *    for every provider in lib/inventory-providers.ts plus the vendors seen in
 *    support@'s own "Inventory Feed Request for: …" emails (2026):
 *      ready (needs_review = false) — request addresses used on 3+ sent requests:
 *        DealerOn (help@dealeron.com)
 *      address seen, needs review — DealerInspire, DealerDotCom, Firstlook (Max Digital),
 *        Advent, Reynolds, Vincue, VinSolutions
 *      CDK, Tekion — request_method 'api' (their own order systems)
 *      everything else — no address yet, needs review
 *    Existing settings for these are never overwritten (only filled where blank).
 *  • Global "Feed requests" templates (one per kind) from lib/crm/feeds/templates.ts,
 *    when the kind has no global template yet.
 *
 *   npm run crm:feeds-seed            dry run
 *   npm run crm:feeds-seed -- --apply
 *   npm run crm:feeds-seed -- --apply --reupload   (re-upload the profiles' PDF templates)
 */
import { createClient } from "@supabase/supabase-js";
import { DMS_PROVIDERS, OTHER_PROVIDERS } from "../lib/inventory-providers";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_FEED_TEMPLATES, FEED_KINDS, FEED_CATEGORY, supplierFolder } from "../lib/crm/feeds/templates";
import { SUPPLIER_PROFILES, supplierProfile } from "../lib/crm/feeds/suppliers";
import { putCrmObject } from "../lib/crm/recordings";
import { sanitizeTemplateHtml } from "../lib/crm/email-html";
import { derived } from "../lib/crm/templates";
import { loadScriptEnv } from "./crm-env";

loadScriptEnv();
/* eslint-disable @typescript-eslint/no-explicit-any */
const APPLY = process.argv.includes("--apply");
const log = (...a: unknown[]) => console.log(APPLY ? "" : "[dry-run]", ...a);

type Seed = { name: string; request_email?: string; cc?: string[]; method?: "email" | "pdf" | "api"; pattern?: string; ready?: boolean; note?: string };
// Team Velocity, Vauto and Autosoft are profiles (lib/crm/feeds/suppliers.ts), not KNOWN entries.
const KNOWN: Seed[] = [
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
    const prof = supplierProfile(name);
    let id = byName.get(name.toLowerCase());
    if (!id) {
      created++;
      log(`add supplier ${name}${prof ? " (profile)" : k?.request_email ? ` <${k.request_email}>` : ""}${k?.method === "api" ? " (portal)" : ""}${prof || k?.ready ? " · ready" : " · needs review"}`);
      if (!APPLY) continue;
      const { data, error } = await admin.from("crm_companies").insert({ kind: "feed_supplier", name }).select("id").single();
      if (error) { console.error(`  ${name}: ${error.message}`); continue; }
      id = data.id;
      byName.set(name.toLowerCase(), id!);
    }
    if (prof) continue;   // the profiles section below owns these
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

  console.log("── supplier profiles (Team Velocity, Vauto, Autosoft — authoritative) ──");
  const { data: profTpls } = await admin.from("crm_email_templates").select("id, name, subject, body_html, feed_kind, supplier_company_id, archived").not("supplier_company_id", "is", null).eq("archived", false);
  for (const prof of SUPPLIER_PROFILES) {
    const id = byName.get(prof.name.toLowerCase());
    if (!id) { log(`${prof.name}: supplier not created yet (dry run) — settings + ${Object.keys(prof.templates).length} templates would follow`); continue; }
    const cur = settings.get(id) ?? null;
    const want: Record<string, unknown> = { ...prof.settings, needs_review: false };
    if (prof.pdfTemplate) {
      const file = path.resolve(__dirname, "..", prof.pdfTemplate);
      const key = `crm/feed-suppliers/${prof.name.toLowerCase()}/${path.basename(file)}`;
      want.pdf_template_s3_key = key;
      if (cur?.pdf_template_s3_key !== key || process.argv.includes("--reupload")) {
        log(`${prof.name}: upload ${prof.pdfTemplate} → s3 ${key}`);
        if (APPLY) await putCrmObject(key, fs.readFileSync(file), "application/pdf");
      }
    }
    const changed = Object.keys(want).filter((k) => JSON.stringify(cur?.[k] ?? null) !== JSON.stringify(want[k]));
    if (changed.length) {
      log(`${prof.name}: settings ${cur ? "update" : "create"} — ${changed.join(", ")}`);
      if (APPLY) {
        const { error } = await admin.from("crm_feed_supplier_settings").upsert({ company_id: id, ...want }, { onConflict: "company_id" });
        if (error) console.error(`  ${prof.name} settings: ${error.message}`);
      }
    } else log(`${prof.name}: settings up to date`);
    for (const [kind, t] of Object.entries(prof.templates)) {
      const body = sanitizeTemplateHtml(t!.body_html);
      const d = derived(t!.subject, body);
      const row = { name: t!.name, category: supplierFolder(prof.name), subject: t!.subject, body_html: body, variables: d.variables, needs_review: d.needs_review, feed_kind: kind, supplier_company_id: id, source: "manual" };
      const ex = (profTpls ?? []).find((r: any) => r.supplier_company_id === id && r.feed_kind === kind);
      if (ex && ex.subject === row.subject && ex.body_html === row.body_html && ex.name === row.name) { log(`${prof.name} ${kind}: template up to date`); continue; }
      log(`${prof.name} ${kind}: ${ex ? "update" : "add"} template "${t!.name}"${d.unknown.length ? ` — UNKNOWN TOKENS ${d.unknown.join(", ")}` : ""}`);
      if (!APPLY) continue;
      const { error } = ex
        ? await admin.from("crm_email_templates").update(row).eq("id", ex.id)
        : await admin.from("crm_email_templates").insert(row);
      if (error) console.error(`  ${prof.name} ${kind}: ${error.message}`);
    }
  }

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
