// Call → company/contact matching for DA-CRM.
//
// Order: the normalized E.164 number against crm_contacts.phone, then against
// the company phone (crm_companies.phone, falling back to the dealer's main
// phone on the platform record). No match → the Unmatched bucket
// (company null) for staff to assign on the Calls page. The lookup is
// injected so scripts/crm-verify-unit.ts can test the rules without a DB.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { normalizePhone } from "./phone";

export type PhoneMatch = {
  e164: string | null;
  companyId: string | null;
  contactId: string | null;
  matchedBy: "contact" | "company_phone" | "none";
  /** How many records shared the number — >1 means staff should double-check. */
  candidates: number;
};

export type ContactHit = { id: string; company_id: string; updated_at: string };
export type CompanyHit = { id: string; kind: string; active: boolean };

export interface MatchLookup {
  contactsByPhone(e164: string): Promise<ContactHit[]>;
  companiesByPhone(e164: string): Promise<CompanyHit[]>;
}

// A shared main line is most often the rooftop's; prefer dealers, then groups.
const KIND_RANK: Record<string, number> = { dealer: 0, group: 1, feed_supplier: 2, vendor: 3 };

export async function matchPhone(raw: string | null | undefined, lookup: MatchLookup): Promise<PhoneMatch> {
  const e164 = normalizePhone(raw);
  if (!e164) return { e164: null, companyId: null, contactId: null, matchedBy: "none", candidates: 0 };

  const contacts = await lookup.contactsByPhone(e164);
  if (contacts.length) {
    // Most recently touched contact wins (one person can sit on several
    // rooftops of a group); `candidates` flags the ambiguity.
    const best = [...contacts].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    return { e164, companyId: best.company_id, contactId: best.id, matchedBy: "contact", candidates: contacts.length };
  }

  const companies = await lookup.companiesByPhone(e164);
  if (companies.length) {
    const best = [...companies].sort((a, b) =>
      Number(b.active) - Number(a.active) || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))[0];
    return { e164, companyId: best.id, contactId: null, matchedBy: "company_phone", candidates: companies.length };
  }

  return { e164, companyId: null, contactId: null, matchedBy: "none", candidates: 0 };
}

/** Supabase-backed lookup (service-role client). */
export function supabaseMatchLookup(admin: any): MatchLookup {
  return {
    async contactsByPhone(e164) {
      const { data, error } = await admin
        .from("crm_contacts")
        .select("id, company_id, updated_at")
        .eq("phone", e164)
        .is("deleted_at", null)
        .limit(20);
      if (error) throw new Error(`crm_contacts lookup: ${error.message}`);
      return (data ?? []) as ContactHit[];
    },
    async companiesByPhone(e164) {
      const { data, error } = await admin.rpc("crm_companies_by_phone", { p_e164: e164 });
      if (error) throw new Error(`crm_companies_by_phone: ${error.message}`);
      return (data ?? []) as CompanyHit[];
    },
  };
}
