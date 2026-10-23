// DA-CRM: re-run contact matching over stored data — after the users → contacts backfill, and nightly from
// crm-contacts-reconcile. Exact matches against live crm_contacts only (phone E.164 / email lowercased):
//   1. calls with no company or no contact          → by the other party's number
//   2. Inbox threads with no company (not internal)  → by external participant emails (sender first)
//   3. email activities with a company, no contact   → by that email's participants, at that company
// A match that points at contacts in more than one company is ambiguous and left alone. Never overwrites
// an existing company or contact.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { normalizePhone } from "./phone";
import { relinkThreadActivities } from "./inbox-ingest";

export type ContactHit = { id: string; company_id: string; updated_at: string };

/** The contact to use, or null. With companyId only contacts there count; without one, hits must agree on a company. */
export function pickContact(hits: ContactHit[], companyId: string | null): ContactHit | null {
  const pool = companyId ? hits.filter((h) => h.company_id === companyId) : hits;
  if (!pool.length) return null;
  if (!companyId && new Set(pool.map((h) => h.company_id)).size > 1) return null;
  return [...pool].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

const DA_DOMAINS = ["dealeraddendums.com"];
export function isExternal(address: string): boolean {
  const d = address.split("@")[1] ?? "";
  return !!d && !DA_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`));
}

/** Participant addresses in match order: from first, then to / cc / bcc; lowercased, external, unique. */
export function orderedAddresses(parts: { address: string | null; role: string | null }[]): string[] {
  const rank: Record<string, number> = { from: 0, sender: 0, reply_to: 1, to: 2, cc: 3, bcc: 4 };
  const out: string[] = [];
  for (const p of [...parts].sort((a, b) => (rank[a.role ?? ""] ?? 5) - (rank[b.role ?? ""] ?? 5))) {
    const a = (p.address ?? "").trim().toLowerCase();
    if (a && isExternal(a) && !out.includes(a)) out.push(a);
  }
  return out;
}

/** First address (in order) that resolves; a sender match beats a cc match. */
export function pickByAddresses(addresses: string[], byEmail: Map<string, ContactHit[]>, companyId: string | null): ContactHit | null {
  for (const a of addresses) {
    const hit = pickContact(byEmail.get(a) ?? [], companyId);
    if (hit) return hit;
  }
  return null;
}

async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await q(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < page) return out;
  }
}

function chunks<T>(xs: T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function contactsBy(admin: any, col: "phone" | "email", values: string[]): Promise<Map<string, ContactHit[]>> {
  const map = new Map<string, ContactHit[]>();
  for (const part of chunks(Array.from(new Set(values)))) {
    const { data, error } = await admin.from("crm_contacts").select("id, company_id, updated_at, phone, email").is("deleted_at", null).in(col, part);
    if (error) throw new Error(error.message);
    for (const c of data ?? []) {
      const k = col === "email" ? String(c.email).toLowerCase() : c.phone;
      map.set(k, [...(map.get(k) ?? []), c]);
    }
  }
  return map;
}

export type RematchReport = {
  apply: boolean;
  calls: { checked: number; company_and_contact: number; contact_only: number };
  threads: { checked: number; matched: number; matched_open: number };
  email_activities: { checked: number; matched: number };
};

export async function rematchContacts(admin: any, { apply }: { apply: boolean }): Promise<RematchReport> {
  const report: RematchReport = {
    apply,
    calls: { checked: 0, company_and_contact: 0, contact_only: 0 },
    threads: { checked: 0, matched: 0, matched_open: 0 },
    email_activities: { checked: 0, matched: 0 },
  };

  // 1. Calls
  const calls = await all<any>((a, b) => admin.from("crm_calls").select("id, activity_id, company_id, contact_id, direction, from_number, to_number")
    .is("contact_id", null).order("id").range(a, b));
  report.calls.checked = calls.length;
  const other = (c: any) => normalizePhone(c.direction === "inbound" ? c.from_number : c.to_number);
  const byPhone = await contactsBy(admin, "phone", calls.map(other).filter(Boolean) as string[]);
  for (const c of calls) {
    const n = other(c);
    const hit = n ? pickContact(byPhone.get(n) ?? [], c.company_id) : null;
    if (!hit) continue;
    if (c.company_id) report.calls.contact_only++; else report.calls.company_and_contact++;
    if (!apply) continue;
    await admin.from("crm_calls").update({ company_id: hit.company_id, contact_id: hit.id }).eq("id", c.id);
    if (c.activity_id) {
      const { data: act } = await admin.from("crm_activities").select("metadata").eq("id", c.activity_id).maybeSingle();
      await admin.from("crm_activities").update({
        company_id: hit.company_id, contact_id: hit.id, metadata: { ...(act?.metadata ?? {}), matched_by: "contact_rematch" },
      }).eq("id", c.activity_id);
    }
  }

  // 2. Inbox threads with no company
  const threads = await all<any>((a, b) => admin.from("crm_email_threads").select("id, status").is("company_id", null).eq("internal", false).order("id").range(a, b));
  report.threads.checked = threads.length;
  const tparts = new Map<string, { address: string | null; role: string | null }[]>();
  for (const part of chunks(threads.map((t) => t.id), 100)) {
    const rows = await all<any>((a, b) => admin.from("crm_email_participants").select("thread_id, address, role").in("thread_id", part).order("email_id").range(a, b));
    for (const r of rows) tparts.set(r.thread_id, [...(tparts.get(r.thread_id) ?? []), r]);
  }
  const tAddr = new Map(threads.map((t) => [t.id, orderedAddresses(tparts.get(t.id) ?? [])]));
  const byEmailT = await contactsBy(admin, "email", Array.from(tAddr.values()).flat());
  for (const t of threads) {
    const hit = pickByAddresses(tAddr.get(t.id) ?? [], byEmailT, null);
    if (!hit) continue;
    report.threads.matched++;
    if (t.status !== "closed") report.threads.matched_open++;
    if (!apply) continue;
    await admin.from("crm_email_threads").update({ company_id: hit.company_id, contact_id: hit.id, matched_by: "contact", match_candidates: [] }).eq("id", t.id);
    await relinkThreadActivities(admin, t.id, hit.company_id, hit.id);
  }

  // 3. Email activities with a company and no contact (after step 2, so its relinks are already done)
  const acts = await all<any>((a, b) => admin.from("crm_activities").select("id, company_id").eq("type", "email").is("contact_id", null).not("company_id", "is", null).order("id").range(a, b));
  report.email_activities.checked = acts.length;
  const emailOf = new Map<string, string>();     // activity → crm_emails.id
  for (const part of chunks(acts.map((x) => x.id))) {
    const { data } = await admin.from("crm_emails").select("id, activity_id").in("activity_id", part);
    for (const e of data ?? []) emailOf.set(e.activity_id, e.id);
  }
  const eparts = new Map<string, { address: string | null; role: string | null }[]>();
  for (const part of chunks(Array.from(emailOf.values()), 100)) {
    const rows = await all<any>((a, b) => admin.from("crm_email_participants").select("email_id, address, role").in("email_id", part).order("email_id").range(a, b));
    for (const r of rows) eparts.set(r.email_id, [...(eparts.get(r.email_id) ?? []), r]);
  }
  const aAddr = new Map(acts.map((x) => [x.id, orderedAddresses(eparts.get(emailOf.get(x.id) ?? "") ?? [])]));
  const byEmailA = await contactsBy(admin, "email", Array.from(aAddr.values()).flat());
  for (const x of acts) {
    const hit = pickByAddresses(aAddr.get(x.id) ?? [], byEmailA, x.company_id);
    if (!hit) continue;
    report.email_activities.matched++;
    if (apply) await admin.from("crm_activities").update({ contact_id: hit.id }).eq("id", x.id).is("contact_id", null);
  }
  return report;
}
