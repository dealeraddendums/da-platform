// Email → company / contact matching for the DA-CRM Inbox.
//
// For each EXTERNAL participant (not one of our mailboxes, not an internal
// domain such as dealeraddendums.com), in order — the sender of an inbound
// message first, then To, then Cc:
//   1. the address against crm_contacts.email (case-insensitive) → that contact's company
//   2. the address listed in crm_companies.emails
//   3. its domain against the company / dealer website and the dealer's
//      primary-contact email domain (free-mail domains like gmail.com never
//      match by domain)
// An exact address beats a domain: one group domain often covers many
// rooftops. Several companies on one domain → no match, the candidates are
// offered in the Unassigned view — unless exactly one of them is a group,
// which is then the match (the group owns the domain).
// No external participants → the thread is internal. The lookup is injected
// so scripts/crm-inbox-verify-unit.ts tests the rules without a database.
/* eslint-disable @typescript-eslint/no-explicit-any */

export type EmailContactHit = { id: string; company_id: string; updated_at: string };
export type EmailCompanyHit = { id: string; kind: string; active: boolean };

export interface EmailMatchLookup {
  contactsByEmail(email: string): Promise<EmailContactHit[]>;
  companiesByEmail(email: string): Promise<EmailCompanyHit[]>;
  companiesByDomain(domain: string): Promise<EmailCompanyHit[]>;
}

export type EmailMatch = {
  companyId: string | null;
  contactId: string | null;
  matchedBy: "contact" | "company_email" | "domain" | null;
  matchedAddress: string | null;
  candidates: string[];      // ambiguous domain hits
  external: string[];        // external participant addresses, in match order
  internal: boolean;         // nobody outside DealerAddendums on it
};

export const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.ca", "ymail.com", "rocketmail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net",
  "verizon.net", "cox.net", "charter.net", "bellsouth.net", "earthlink.net", "protonmail.com", "proton.me",
  "gmx.com", "mail.com", "zoho.com", "frontier.com", "windstream.net", "optonline.net",
]);

const KIND_RANK: Record<string, number> = { dealer: 0, group: 1, feed_supplier: 2, vendor: 3 };

export function normEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  const addr = m ? m[1] : s;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) ? addr : null;
}

export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

export type InboxRules = {
  ownAddresses: string[];       // our mailboxes
  internalDomains: string[];    // e.g. dealeraddendums.com
  ignoreSenders: string[];      // substrings of From (see crm_settings.email_ignore_senders)
};

export function isInternalAddress(address: string, rules: Pick<InboxRules, "ownAddresses" | "internalDomains">): boolean {
  const a = address.toLowerCase();
  if (rules.ownAddresses.map((x) => x.toLowerCase()).includes(a)) return true;
  const d = emailDomain(a);
  return rules.internalDomains.some((x) => { const dom = x.toLowerCase().replace(/^@/, ""); return d === dom || d.endsWith(`.${dom}`); });
}

/** Automated sender we never store (noreply@, bounces, Mandrill notices, …). */
export function isIgnoredSender(address: string | null, patterns: string[]): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  return patterns.some((p) => { const s = p.trim().toLowerCase(); return !!s && a.includes(s); });
}

function bestCompany(hits: EmailCompanyHit[]): EmailCompanyHit {
  return [...hits].sort((a, b) => Number(b.active) - Number(a.active) || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))[0];
}

/** `ordered` = participant addresses in priority order (duplicates fine). */
export async function matchEmailParticipants(ordered: (string | null | undefined)[], lookup: EmailMatchLookup, rules: Pick<InboxRules, "ownAddresses" | "internalDomains">): Promise<EmailMatch> {
  const external: string[] = [];
  for (const raw of ordered) {
    const a = normEmail(raw);
    if (a && !isInternalAddress(a, rules) && !external.includes(a)) external.push(a);
  }
  const none: EmailMatch = { companyId: null, contactId: null, matchedBy: null, matchedAddress: null, candidates: [], external, internal: external.length === 0 };
  if (!external.length) return none;

  // Exact addresses first, across every participant…
  for (const a of external) {
    const contacts = await lookup.contactsByEmail(a);
    if (contacts.length) {
      const best = [...contacts].sort((x, y) => y.updated_at.localeCompare(x.updated_at))[0];
      return { ...none, companyId: best.company_id, contactId: best.id, matchedBy: "contact", matchedAddress: a };
    }
  }
  for (const a of external) {
    const cos = await lookup.companiesByEmail(a);
    if (cos.length) return { ...none, companyId: bestCompany(cos).id, matchedBy: "company_email", matchedAddress: a };
  }
  // …then domains.
  const candidates: string[] = [];
  for (const a of external) {
    const d = emailDomain(a);
    if (FREEMAIL_DOMAINS.has(d)) continue;
    const cos = await lookup.companiesByDomain(d);
    if (cos.length === 1) return { ...none, companyId: cos[0].id, matchedBy: "domain", matchedAddress: a };
    if (cos.length > 1) {
      const groups = cos.filter((c) => c.kind === "group");
      if (groups.length === 1) return { ...none, companyId: groups[0].id, matchedBy: "domain", matchedAddress: a };
      for (const c of cos) if (!candidates.includes(c.id)) candidates.push(c.id);
    }
  }
  return { ...none, candidates: candidates.slice(0, 10) };
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Supabase-backed lookup (service-role client). */
export function supabaseEmailLookup(admin: any): EmailMatchLookup {
  return {
    async contactsByEmail(email) {
      const { data, error } = await admin.from("crm_contacts").select("id, company_id, updated_at")
        .ilike("email", likeEscape(email)).is("deleted_at", null).limit(20);
      if (error) throw new Error(`crm_contacts lookup: ${error.message}`);
      return (data ?? []) as EmailContactHit[];
    },
    async companiesByEmail(email) {
      const { data, error } = await admin.rpc("crm_companies_by_email", { p_email: email });
      if (error) throw new Error(`crm_companies_by_email: ${error.message}`);
      return (data ?? []) as EmailCompanyHit[];
    },
    async companiesByDomain(domain) {
      const { data, error } = await admin.rpc("crm_companies_by_email_domain", { p_domain: domain });
      if (error) throw new Error(`crm_companies_by_email_domain: ${error.message}`);
      // Same company can come back through two columns.
      const seen = new Set<string>();
      return ((data ?? []) as EmailCompanyHit[]).filter((c) => !seen.has(c.id) && !!seen.add(c.id));
    },
  };
}
