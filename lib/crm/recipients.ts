// DA-CRM compose window recipients (components/crm/RecipientField.tsx, /api/crm/compose/recipients):
//   suggest  — contacts matching what's typed, this company's first (empty query → this company's contacts)
//   resolve  — what a typed address is: a contact here, a contact at another company, one of us, or
//              not in the CRM (with the company its domain points at, when there is one)
// and the send-time half (lib/crm/inbox-send.ts): add "also add as contact" rows to the compose company.
// The classification is pure and unit-tested (scripts/crm-compose-verify-unit.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { emailDomain, FREEMAIL_DOMAINS, normEmail } from "./inbox-match";
import { companyNames } from "./queries";
import { linkPlatformUser } from "./contact-input";
import { emitContact } from "./companies";

export type RecipientContact = {
  id: string; name: string; email: string; title: string | null; company_id: string; company_name: string; weak: boolean;
};
export type RecipientDomainCompany = { id: string; name: string; kind: string };
export type RecipientStatus = "here" | "elsewhere" | "internal" | "none";
export type ResolvedRecipient = {
  email: string;
  status: RecipientStatus;
  contact: RecipientContact | null;     // here: the contact at this company; elsewhere: the best one elsewhere
  others: RecipientContact[];           // the same address at other companies
  domainCompanies: RecipientDomainCompany[]; // "none": companies its domain belongs to (hint)
  dealerDomain: boolean;                // a dealer / group domain → "also add as contact" defaults on
};

export const contactDisplayName = (c: { first_name?: string | null; last_name?: string | null; email?: string | null }) =>
  [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unnamed";

/** "Jane Doe" / "Doe, Jane" / jane.doe@x.com → { first, last }. Pure. */
export function splitName(display: string | null | undefined, email: string): { first: string; last: string | null } {
  const d = (display ?? "").replace(/["']/g, "").trim();
  if (d && !d.includes("@")) {
    const comma = /^([^,]+),\s*(.+)$/.exec(d);
    if (comma) return { first: comma[2].trim(), last: comma[1].trim() };
    const parts = d.split(/\s+/);
    return { first: parts[0], last: parts.slice(1).join(" ") || null };
  }
  const local = email.split("@")[0].replace(/\d+$/, "");
  const bits = local.split(/[._-]+/).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase());
  return bits.length > 1 ? { first: bits[0], last: bits.slice(1).join(" ") } : { first: bits[0] || local || email, last: null };
}

/** Pure: put a typed address in one of the four states. `hits` = live contacts with this address anywhere. */
export function classifyRecipient(
  email: string,
  hits: RecipientContact[],
  opts: { companyId: string | null; internalDomains: string[]; domainCompanies: RecipientDomainCompany[] },
): ResolvedRecipient {
  const domain = emailDomain(email);
  const dealerDomain = !FREEMAIL_DOMAINS.has(domain) && opts.domainCompanies.some((c) => c.kind === "dealer" || c.kind === "group");
  const base = { email, others: [] as RecipientContact[], domainCompanies: [] as RecipientDomainCompany[], dealerDomain };
  if (opts.internalDomains.map((d) => d.toLowerCase()).includes(domain)) return { ...base, status: "internal", contact: null };
  // Strong contacts before "verify" record contacts.
  const sorted = [...hits].sort((a, b) => Number(a.weak) - Number(b.weak));
  const here = sorted.find((c) => opts.companyId && c.company_id === opts.companyId) ?? null;
  const elsewhere = sorted.filter((c) => c !== here);
  if (here) return { ...base, status: "here", contact: here, others: elsewhere };
  if (elsewhere.length) return { ...base, status: "elsewhere", contact: elsewhere[0], others: elsewhere.slice(1) };
  return { ...base, status: "none", contact: null, domainCompanies: opts.domainCompanies.filter((c) => c.id !== opts.companyId).slice(0, 3) };
}

/** Pure: rank suggestions — this company's contacts first, then exact-start matches, then the rest. */
export function rankSuggestions(list: RecipientContact[], q: string, companyId: string | null): RecipientContact[] {
  const t = q.trim().toLowerCase();
  const starts = (c: RecipientContact) => !!t && (c.email.startsWith(t) || c.name.toLowerCase().startsWith(t)
    || c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)));
  const score = (c: RecipientContact) => (companyId && c.company_id === companyId ? 0 : 4) + (starts(c) ? 0 : 2) + (c.weak ? 1 : 0);
  return [...list].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const CONTACT_COLS = "id, company_id, first_name, last_name, email, title, verify_reason, verified_at";

async function decorate(admin: any, rows: any[]): Promise<RecipientContact[]> {
  const names = await companyNames(rows.map((r) => r.company_id), admin);
  return rows.filter((r) => normEmail(r.email)).map((r) => ({
    id: r.id, name: contactDisplayName(r), email: normEmail(r.email)!, title: r.title ?? null,
    company_id: r.company_id, company_name: names[r.company_id] ?? "Unknown company", weak: !!r.verify_reason && !r.verified_at,
  }));
}

/** Contacts for the TO / CC / BCC dropdown. */
export async function suggestRecipients(admin: any, q: string, companyId: string | null): Promise<RecipientContact[]> {
  const term = q.trim().replace(/[,()*"\\]/g, " ").replace(/\s+/g, " ").slice(0, 80);
  if (term.length < 2) {
    if (!companyId) return [];
    const { data } = await admin.from("crm_contacts").select(CONTACT_COLS).eq("company_id", companyId)
      .is("deleted_at", null).not("email", "is", null).order("first_name").limit(50);
    return rankSuggestions(await decorate(admin, data ?? []), "", companyId);
  }
  const words = term.split(" ");
  const w = likeEscape(words[0]);
  const match = () => admin.from("crm_contacts").select(CONTACT_COLS).is("deleted_at", null).not("email", "is", null)
    .or(`email.ilike.%${w}%,first_name.ilike.%${w}%,last_name.ilike.%${w}%`);
  // This company's matches separately, so a common string can't push them out of the CRM-wide page.
  const [{ data: here }, { data }] = await Promise.all([
    companyId ? match().eq("company_id", companyId).limit(50) : Promise.resolve({ data: [] }),
    match().limit(200),
  ]);
  let rows: any[] = [...(here ?? []), ...(data ?? [])].filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
  // "jane doe": every word must hit the name or the address.
  if (words.length > 1) {
    rows = rows.filter((r) => {
      const hay = `${r.first_name ?? ""} ${r.last_name ?? ""} ${r.email ?? ""}`.toLowerCase();
      return words.every((x) => hay.includes(x.toLowerCase()));
    });
  }
  return rankSuggestions(await decorate(admin, rows), term, companyId).slice(0, 20);
}

/** Companies a domain belongs to (crm_company_domains — website, VDP hosts, platform users — then the Inbox rule). */
export async function companiesForDomain(admin: any, domain: string): Promise<RecipientDomainCompany[]> {
  if (FREEMAIL_DOMAINS.has(domain)) return [];
  const [{ data: d1 }, { data: d2 }] = await Promise.all([
    admin.from("crm_company_domains").select("company_id, source").eq("domain", domain).limit(20),
    admin.rpc("crm_companies_by_email_domain", { p_domain: domain }),
  ]);
  const rank: Record<string, number> = { website: 0, users: 1, vdp: 2, members: 3, group: 4 };
  const ids = [
    ...(d1 ?? []).sort((a: any, b: any) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9)).map((r: any) => r.company_id),
    ...(d2 ?? []).map((r: any) => r.id),
  ].filter((id, i, all) => all.indexOf(id) === i).slice(0, 10);
  if (!ids.length) return [];
  const { data: cos } = await admin.from("crm_company_directory").select("id, name, kind").in("id", ids);
  const byId = new Map((cos ?? []).map((c: any) => [c.id, c]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((c: any) => ({ id: c.id, name: c.name, kind: c.kind }));
}

/** Live contacts with this exact address, any company. */
export async function contactsWithEmail(admin: any, email: string): Promise<RecipientContact[]> {
  const { data } = await admin.from("crm_contacts").select(CONTACT_COLS).ilike("email", likeEscape(email)).is("deleted_at", null).limit(20);
  return decorate(admin, data ?? []);
}

export async function internalDomains(admin: any): Promise<string[]> {
  const { data: s } = await admin.from("crm_settings").select("email_internal_domains").eq("id", true).maybeSingle();
  return Array.isArray(s?.email_internal_domains) ? s.email_internal_domains : ["dealeraddendums.com"];
}

/** Resolve typed addresses (up to 50) for the chips. */
export async function resolveRecipients(admin: any, emails: string[], companyId: string | null): Promise<ResolvedRecipient[]> {
  const list = Array.from(new Set(emails.map((e) => normEmail(e)).filter((e): e is string => !!e))).slice(0, 50);
  const internal = await internalDomains(admin);
  const domainCache = new Map<string, Promise<RecipientDomainCompany[]>>();
  return Promise.all(list.map(async (email) => {
    const d = emailDomain(email);
    if (!domainCache.has(d)) domainCache.set(d, internal.includes(d) ? Promise.resolve([]) : companiesForDomain(admin, d));
    const [hits, domainCompanies] = await Promise.all([contactsWithEmail(admin, email), domainCache.get(d)!]);
    return classifyRecipient(email, hits, { companyId, internalDomains: internal, domainCompanies });
  }));
}

/**
 * Send time: add each address as a contact of the compose company ("Also add as contact of …").
 * Name / title / phone are copied from the same person at another company, else taken from the
 * recipient's display name. An address that is already a contact here is left alone.
 * Returns the ids of the contacts created.
 */
export async function addRecipientsAsContacts(
  admin: any, companyId: string, recipients: { email: string; name?: string | null }[],
): Promise<string[]> {
  const created: string[] = [];
  for (const r of recipients) {
    const email = normEmail(r.email);
    if (!email) continue;
    const { data: rows } = await admin.from("crm_contacts").select("id, company_id, first_name, last_name, title, phone")
      .ilike("email", likeEscape(email)).is("deleted_at", null).order("updated_at", { ascending: false }).limit(20);
    if ((rows ?? []).some((c: any) => c.company_id === companyId)) continue;
    const src = (rows ?? [])[0];
    const n = splitName(r.name, email);
    const userId = await linkPlatformUser(admin, companyId, email);
    const { data, error } = await admin.from("crm_contacts").insert({
      company_id: companyId, user_id: userId, email, source: "manual",
      first_name: src?.first_name || n.first, last_name: src ? src.last_name : n.last, title: src?.title ?? null, phone: src?.phone ?? null,
    }).select("id").single();
    if (error) { if (error.code !== "23505") console.error(`[crm-compose] add contact ${email}: ${error.message}`); continue; }
    created.push(data.id);
    await emitContact(admin, "contact.created", data.id).catch(() => {});
  }
  return created;
}
