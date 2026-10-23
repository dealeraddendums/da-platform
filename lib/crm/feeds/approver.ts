// Feed-order approver = a CRM contact (migration 198).
//   approverCandidates — the Start feed order picker: the company's contacts, plus its group's for a
//     group dealer (labelled with the group name). Past approvers first, then platform users, then by name.
//   resolveApproverContact — on Start: a picked contact is linked (and its blank fields filled from what
//     staff typed); a typed-in approver becomes a contact of the dealer (source 'feed_order', role_tag
//     'approver'), deduped on email at that company. Either way the contact gets approver_at.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { normEmail } from "../inbox-match";
import { normalizePhone } from "../phone";
import { linkPlatformUser } from "../contact-input";
import { emitContact } from "../companies";
import { splitName } from "../recipients";

export type ApproverCandidate = {
  id: string; company_id: string; company_label: string | null;   // null = the order's own company
  name: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null;
  platform_user: boolean; approver: boolean;
};

const COLS = "id, company_id, first_name, last_name, email, phone, phone_raw, title, role_tag, user_id, approver_at";

/** Pure: past approvers, then platform users, then everyone else; by name within each. */
export function rankApprovers<T extends { approver: boolean; platform_user: boolean; name: string; company_label: string | null }>(list: T[]): T[] {
  const rank = (c: T) => (c.approver ? 0 : 2) + (c.platform_user ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || Number(!!a.company_label) - Number(!!b.company_label) || a.name.localeCompare(b.name));
}

/** The company's group (crm company id + name) when it's a dealer in a group. */
async function parentGroup(admin: any, companyId: string): Promise<{ id: string; name: string } | null> {
  const { data: d } = await admin.from("crm_company_directory").select("kind, parent_group_id").eq("id", companyId).maybeSingle();
  if (d?.kind !== "dealer" || !d.parent_group_id) return null;
  const { data: g } = await admin.from("crm_company_directory").select("id, name").eq("kind", "group").eq("group_id", d.parent_group_id).maybeSingle();
  return g ? { id: g.id, name: g.name } : null;
}

export async function approverCandidates(admin: any, companyId: string): Promise<ApproverCandidate[]> {
  const group = await parentGroup(admin, companyId);
  const ids = [companyId, ...(group ? [group.id] : [])];
  const { data } = await admin.from("crm_contacts").select(COLS).in("company_id", ids).is("deleted_at", null).limit(400);
  return rankApprovers((data ?? []).map((c: any) => ({
    id: c.id, company_id: c.company_id, company_label: c.company_id === companyId ? null : group?.name ?? null,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Unnamed",
    first_name: c.first_name, last_name: c.last_name, email: c.email, phone: c.phone ?? c.phone_raw ?? null, title: c.title,
    platform_user: !!c.user_id, approver: !!c.approver_at || c.role_tag === "approver",
  })));
}

export type ApproverInput = { contactId?: string | null; name?: string | null; email?: string | null; phone?: string | null; title?: string | null };

/**
 * The contact behind this order's approver, created or linked. `companyId` = the company the order
 * starts from (the dealer, or the group for a group order). Returns null when nothing identifies anyone.
 * Throws "not_allowed" for a picked contact outside that company / its group.
 */
export async function resolveApproverContact(admin: any, companyId: string, a: ApproverInput, now = new Date()): Promise<{ id: string; created: boolean; contact: any } | null> {
  const stamp = now.toISOString();
  const email = normEmail(a.email);
  const name = (a.name ?? "").trim();
  const title = (a.title ?? "").trim() || null;
  const rawPhone = (a.phone ?? "").trim() || null;
  const phone = rawPhone ? normalizePhone(rawPhone) : null;

  if (a.contactId) {
    const { data: c } = await admin.from("crm_contacts").select(COLS).eq("id", a.contactId).is("deleted_at", null).maybeSingle();
    if (!c) throw new Error("not_found");
    const group = await parentGroup(admin, companyId);
    if (c.company_id !== companyId && c.company_id !== group?.id) throw new Error("not_allowed");
    await admin.from("crm_contacts").update({ approver_at: stamp, ...fillBlanks(c, { email, title, phone, rawPhone }) }).eq("id", c.id);
    return { id: c.id, created: false, contact: { ...c, approver_at: stamp } };
  }
  if (!name && !email) return null;

  // Dedupe: the same email at this company → link it; no email → the same name with no email.
  let existing: any = null;
  if (email) {
    const { data } = await admin.from("crm_contacts").select(COLS).eq("company_id", companyId).is("deleted_at", null)
      .ilike("email", email.replace(/[\\%_]/g, (x) => `\\${x}`)).limit(1);
    existing = data?.[0] ?? null;
  } else {
    const n = splitName(name, "x@x");
    let q = admin.from("crm_contacts").select(COLS).eq("company_id", companyId).is("deleted_at", null).is("email", null).ilike("first_name", n.first);
    q = n.last ? q.ilike("last_name", n.last) : q.is("last_name", null);
    existing = (await q.limit(1)).data?.[0] ?? null;
  }
  if (existing) {
    const n = name ? splitName(name, email ?? "x@x") : null;
    const patch: Record<string, unknown> = { approver_at: stamp, ...fillBlanks(existing, { email, title, phone, rawPhone }) };
    if (!existing.first_name && n?.first) patch.first_name = n.first;
    if (!existing.last_name && n?.last) patch.last_name = n.last;
    await admin.from("crm_contacts").update(patch).eq("id", existing.id);
    if (Object.keys(patch).length > 1) await emitContact(admin, "contact.updated", existing.id).catch(() => {});
    return { id: existing.id, created: false, contact: { ...existing, ...patch } };
  }

  const n = splitName(name || null, email ?? "approver@unknown");
  const row = {
    company_id: companyId, email, first_name: n.first || "Approver", last_name: n.last, title, phone,
    phone_raw: rawPhone && !phone ? rawPhone : null, role_tag: "approver", source: "feed_order", approver_at: stamp,
    user_id: email ? await linkPlatformUser(admin, companyId, email) : null,
  };
  const { data, error } = await admin.from("crm_contacts").insert(row).select(COLS).single();
  if (error) {
    // Raced another create with the same email: link that one.
    if (error.code === "23505" && email) return resolveApproverContact(admin, companyId, { ...a, contactId: null }, now);
    throw new Error(`approver contact: ${error.message}`);
  }
  await emitContact(admin, "contact.created", data.id).catch(() => {});
  return { id: data.id, created: true, contact: data };
}

/** Fill only the contact's blank fields from what staff typed. Pure. */
export function fillBlanks(c: any, v: { email: string | null; title: string | null; phone: string | null; rawPhone: string | null }): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (!c.email && v.email) p.email = v.email;
  if (!c.title && v.title) p.title = v.title;
  if (!c.phone && !c.phone_raw && v.rawPhone) { if (v.phone) p.phone = v.phone; else p.phone_raw = v.rawPhone; }
  return p;
}
