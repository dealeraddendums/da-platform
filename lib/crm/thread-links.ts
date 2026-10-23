// An email thread belongs to every CRM contact it was sent to (migration 197, crm_email_thread_contacts).
// The thread keeps one primary company / contact (crm_email_threads); these links put it — and its
// messages — on each recipient contact's and their companies' timelines and Email tabs too.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { normEmail } from "./inbox-match";

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Link the thread to every live contact (any company) whose address is among `emails`. Returns the contact ids. */
export async function linkThreadToRecipients(admin: any, threadId: string, emails: string[], staffId: string | null): Promise<string[]> {
  const list = Array.from(new Set(emails.map((e) => normEmail(e)).filter((e): e is string => !!e))).slice(0, 100);
  const ids: string[] = [];
  for (const email of list) {
    const { data } = await admin.from("crm_contacts").select("id").ilike("email", likeEscape(email)).is("deleted_at", null).limit(20);
    for (const c of data ?? []) if (!ids.includes(c.id)) ids.push(c.id);
  }
  return linkThreadContacts(admin, threadId, ids, staffId);
}

export async function linkThreadContacts(admin: any, threadId: string, contactIds: string[], staffId: string | null, source: "compose" | "manual" = "compose"): Promise<string[]> {
  const ids = Array.from(new Set(contactIds.filter(Boolean)));
  if (!ids.length) return [];
  const { error } = await admin.from("crm_email_thread_contacts").upsert(
    ids.map((contact_id) => ({ thread_id: threadId, contact_id, source, created_by: staffId })),
    { onConflict: "thread_id,contact_id", ignoreDuplicates: true },
  );
  if (error) { console.error(`[crm-thread-links] ${threadId}: ${error.message}`); return []; }
  return ids;
}

/** Thread ids linked to this company (through its contacts) or this contact. */
export async function linkedThreadIds(admin: any, ref: { companyId?: string | null; contactId?: string | null }): Promise<string[]> {
  if (!ref.companyId && !ref.contactId) return [];
  const { data, error } = await admin.rpc("crm_linked_thread_ids", { p_company: ref.contactId ? null : ref.companyId ?? null, p_contact: ref.contactId ?? null });
  if (error) { console.error(`[crm-thread-links] lookup: ${error.message}`); return []; }
  // setof uuid comes back as bare strings (or { crm_linked_thread_ids } objects on some clients).
  return (data ?? []).map((r: any) => (typeof r === "string" ? r : r?.crm_linked_thread_ids)).filter(Boolean).slice(0, 500);
}

/** PostgREST filter: the thread is this record's primary or linked to it. */
export function threadOwnerFilter(column: "company_id" | "contact_id", id: string, linked: string[]): string {
  return linked.length ? `${column}.eq.${id},id.in.(${linked.join(",")})` : `${column}.eq.${id}`;
}
