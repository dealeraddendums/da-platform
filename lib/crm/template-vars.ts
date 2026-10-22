// DA-CRM email template variables — catalogue, renderer, HubSpot token
// conversion. Pure and client-safe (the template editor's variable picker and
// the server compose path share it).
//
// Syntax: {{group.field}} with an optional fallback: {{contact.first_name | "there"}}.
// Values are HTML-escaped when rendering a body. A token that isn't in the
// catalogue is left untouched and reported as `unknown`; a known variable with
// no value (and no fallback) renders empty and is reported as `missing`.

export type VarDef = { key: string; label: string; example: string };
export type VarGroup = { group: string; label: string; vars: VarDef[] };

export const TEMPLATE_VARIABLES: VarGroup[] = [
  { group: "contact", label: "Contact", vars: [
    { key: "contact.first_name", label: "First name", example: "Chris" },
    { key: "contact.last_name", label: "Last name", example: "Hand" },
    { key: "contact.full_name", label: "Full name", example: "Chris Hand" },
    { key: "contact.email", label: "Email", example: "chris@example.com" },
    { key: "contact.phone", label: "Phone", example: "(801) 555-0100" },
    { key: "contact.title", label: "Title", example: "General Manager" },
  ] },
  { group: "company", label: "Company", vars: [
    { key: "company.name", label: "Name", example: "Battleground Kia" },
    { key: "company.dealer_id", label: "Dealer ID", example: "MP11922" },
    { key: "company.address", label: "Street address", example: "123 Main St" },
    { key: "company.city", label: "City", example: "Vancouver" },
    { key: "company.state", label: "State", example: "WA" },
    { key: "company.zip", label: "ZIP", example: "98682" },
    { key: "company.phone", label: "Phone", example: "(360) 555-0199" },
    { key: "company.fax", label: "Fax", example: "(360) 555-0198" },
    { key: "company.website", label: "Website", example: "https://battlegroundkia.com" },
  ] },
  { group: "staff", label: "Me (sender)", vars: [
    { key: "staff.full_name", label: "Full name", example: "Marlena Tone" },
    { key: "staff.first_name", label: "First name", example: "Marlena" },
    { key: "staff.email", label: "Email", example: "support@dealeraddendums.com" },
    { key: "staff.phone", label: "Direct line", example: "(801) 415-9435" },
  ] },
  { group: "owner", label: "Company owner", vars: [
    { key: "owner.full_name", label: "Full name", example: "Alex Smith" },
    { key: "owner.first_name", label: "First name", example: "Alex" },
  ] },
  { group: "trial", label: "Trial", vars: [
    { key: "trial.day", label: "Trial day", example: "12" },
    { key: "trial.days_left", label: "Days left", example: "18" },
    { key: "trial.ends_on", label: "Ends on", example: "November 9, 2026" },
  ] },
  // Feed orders (Phase 2b) — filled only when a feed-request email is composed for an order.
  { group: "supplier", label: "Feed supplier", vars: [
    { key: "supplier.name", label: "Name", example: "vAuto" },
    { key: "supplier.request_email", label: "Request email", example: "vat.support@coxautoinc.com" },
  ] },
  { group: "approver", label: "Feed approver", vars: [
    { key: "approver.name", label: "Name", example: "Bill Meier" },
    { key: "approver.first_name", label: "First name", example: "Bill" },
    { key: "approver.email", label: "Email", example: "bill@herzogmeier.com" },
    { key: "approver.title", label: "Title", example: "General Manager" },
  ] },
  { group: "dealer", label: "Dealer feed", vars: [
    { key: "dealer.dms", label: "DMS / feed provider", example: "Reynolds" },
  ] },
  { group: "order", label: "Feed order", vars: [
    { key: "order.id", label: "Order number", example: "FO-1A2B3C" },
    { key: "order.sent_on", label: "Request sent on", example: "October 21, 2026" },
    { key: "order.feed_id", label: "Feed ID", example: "MP12601" },
    { key: "order.case_number", label: "Supplier case number", example: "08192068" },
    // One per supplier question (crm_feed_supplier_settings.extra_fields); any
    // order.supplier_fields.<key>[.<option>] is accepted — see isKnownVariable.
    { key: "order.supplier_fields.autosoft_account", label: "Supplier field (e.g. Autosoft account)", example: "ABCD17" },
  ] },
  { group: "date", label: "Date", vars: [
    { key: "today", label: "Today", example: "October 21, 2026" },
    { key: "today.short", label: "Today (MM/DD/YYYY)", example: "10/21/2026" },
  ] },
];

export const VARIABLE_KEYS = new Set(TEMPLATE_VARIABLES.flatMap((g) => g.vars.map((v) => v.key)));

// Supplier questions are per supplier, so their keys can't all be in the catalogue.
const SUPPLIER_FIELD_KEY = /^order\.supplier_fields\.[a-z][a-z0-9_]*(\.[A-Za-z0-9][A-Za-z0-9_]*)?$/;

/** A variable DA-CRM can fill: the catalogue, plus order.supplier_fields.<key>[.<option>]. */
export const isKnownVariable = (key: string) => VARIABLE_KEYS.has(key) || SUPPLIER_FIELD_KEY.test(key);

export type TemplateContext = Record<string, string | number | null | undefined>;

// {{ key }} or {{ key | "fallback" }} / {{ key | 'fallback' }}
const TOKEN = /\{\{\s*([^{}|]+?)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'))?\s*\}\}/g;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type RenderResult = { text: string; missing: string[]; unknown: string[] };

/** Fill variables. `html: true` escapes values (bodies); subjects render plain. */
export function renderTemplate(text: string, ctx: TemplateContext, opts: { html: boolean }): RenderResult {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const out = text.replace(TOKEN, (whole, rawKey: string, fbDq?: string, fbSq?: string) => {
    const key = rawKey.trim();
    if (!isKnownVariable(key)) { unknown.add(key); return whole; }
    const v = ctx[key];
    const value = v == null || String(v).trim() === "" ? (fbDq ?? fbSq ?? null) : String(v);
    if (value == null) { missing.add(key); return ""; }
    return opts.html ? escapeHtml(value) : value;
  });
  return { text: out, missing: Array.from(missing), unknown: Array.from(unknown) };
}

/** Catalogue variables a template uses (for the cached `variables` column). */
export function findVariables(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of Array.from(t.matchAll(TOKEN))) if (isKnownVariable(m[1].trim())) found.add(m[1].trim());
  return Array.from(found).sort();
}

/** Tokens in a template that DA-CRM can't fill. */
export function findUnknownTokens(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of Array.from(t.matchAll(/\{\{\s*([^{}]+?)\s*\}\}|\{%\s*([^%]+?)\s*%\}/g))) {
    const key = (m[1] ?? m[2]).split("|")[0].trim();
    if (!isKnownVariable(key)) found.add(m[0]);
  }
  return Array.from(found);
}

// ── HubSpot → DA-CRM ─────────────────────────────────────────────────────────
// Built from the tokens our own HubSpot templates use (export 2026-09:
// contact.firstname ×122, company.name ×77, company.city/state ×34, …).

/** Exact equivalents. */
export const HUBSPOT_TOKEN_MAP: Record<string, string> = {
  "contact.firstname": "contact.first_name",
  "contact.lastname": "contact.last_name",
  "contact.email": "contact.email",
  "contact.phone": "contact.phone",
  "contact.mobilephone": "contact.phone",
  "contact.jobtitle": "contact.title",
  "contact.company": "company.name",
  "contact.dealer_id": "company.dealer_id",
  "company.name": "company.name",
  "company.address": "company.address",
  "company.city": "company.city",
  "company.state": "company.state",
  "company.zip": "company.zip",
  "company.phone": "company.phone",
  "company.domain": "company.website",
  "company.website": "company.website",
  "company.dealer_id": "company.dealer_id",
  "sender.firstname": "staff.first_name",
  "sender.fullname": "staff.full_name",
  "sender.email": "staff.email",
  "sender.phone": "staff.phone",
  "owner.firstname": "owner.first_name",
  "owner.fullname": "owner.full_name",
  "contact.hubspot_owner_id.firstname": "owner.first_name",
};

/** Close but not identical — converted, and listed so someone checks the wording. */
export const HUBSPOT_APPROXIMATE: Record<string, { to: string; why: string }> = {
  "contact.address": { to: "company.address", why: "DA-CRM keeps addresses on the company, not the contact" },
  "contact.city": { to: "company.city", why: "DA-CRM keeps addresses on the company, not the contact" },
  "contact.state": { to: "company.state", why: "DA-CRM keeps addresses on the company, not the contact" },
  "contact.zip": { to: "company.zip", why: "DA-CRM keeps addresses on the company, not the contact" },
  "sender.lastname": { to: "staff.full_name", why: "DA-CRM has the sender's full name, not a separate last name" },
};

export type TokenFinding = { from: string; to?: string; count: number; why?: string };
export type ConversionReport = { converted: TokenFinding[]; approximated: TokenFinding[]; unmapped: TokenFinding[] };

/**
 * Rewrite HubSpot tokens to DA-CRM variables. `| default("x")` / `| default('x')`
 * becomes our fallback. Unmapped tokens (HubL `{{if …}}` / `{% if %}` blocks,
 * document links, custom properties) are left exactly as they are and reported,
 * so nothing silently disappears from a customer email.
 */
export function convertHubspotTokens(text: string): { text: string; report: ConversionReport } {
  const tally = (m: Map<string, TokenFinding>, f: Omit<TokenFinding, "count">) => {
    const k = `${f.from}→${f.to ?? ""}`;
    const cur = m.get(k);
    if (cur) cur.count++; else m.set(k, { ...f, count: 1 });
  };
  const converted = new Map<string, TokenFinding>(), approximated = new Map<string, TokenFinding>(), unmapped = new Map<string, TokenFinding>();

  let out = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, inner: string) => {
    const [rawKey, ...filters] = inner.split("|").map((s) => s.trim());
    const key = rawKey.toLowerCase();
    let fallback: string | null = null;
    for (const f of filters) {
      const m = /^default\(\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(f);
      if (m) fallback = m[1] ?? m[2] ?? "";
    }
    const unsupportedFilter = filters.some((f) => !/^default\(/i.test(f));
    const target = HUBSPOT_TOKEN_MAP[key] ?? HUBSPOT_APPROXIMATE[key]?.to;
    if (VARIABLE_KEYS.has(rawKey) && !filters.length) return whole; // already DA-CRM
    if (!target || unsupportedFilter) { tally(unmapped, { from: whole }); return whole; }
    if (HUBSPOT_TOKEN_MAP[key]) tally(converted, { from: rawKey, to: target });
    else tally(approximated, { from: rawKey, to: target, why: HUBSPOT_APPROXIMATE[key].why });
    return fallback != null ? `{{${target} | "${fallback.replace(/"/g, "'")}"}}` : `{{${target}}}`;
  });
  // HubL statement blocks ({% if %} … {% endif %}) have no DA-CRM equivalent.
  out = out.replace(/\{%[\s\S]*?%\}/g, (whole) => { tally(unmapped, { from: whole }); return whole; });

  return { text: out, report: { converted: Array.from(converted.values()), approximated: Array.from(approximated.values()), unmapped: Array.from(unmapped.values()) } };
}
