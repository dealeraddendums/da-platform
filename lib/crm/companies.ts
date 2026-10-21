// DA-CRM company + contact writes that other systems care about: stage and
// owner changes write a status_change activity AND emit an outbound webhook;
// contact create/update emit contact.created / contact.updated.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { emitCrmEvent } from "./outbound";

import { STAGE_LABEL, type Stage } from "./format";
export { STAGES, STAGE_LABEL, KIND_LABEL, ROLE_TAGS, type Stage } from "./format";

/** Identifiers a subscriber (da-billing) needs to find its own record. */
export async function companyRef(admin: any, companyId: string): Promise<Record<string, unknown> | null> {
  const { data: c } = await admin.from("crm_companies")
    .select("id, kind, name, dealer_id, group_id, dealer:dealers(dealer_id, internal_id, billing_customer_id, name), grp:groups(name, billing_customer_id)")
    .eq("id", companyId).maybeSingle();
  if (!c) return null;
  return {
    company_id: c.id,
    kind: c.kind,
    name: c.dealer?.name ?? c.grp?.name ?? c.name,
    dealer_uuid: c.dealer_id,
    dealer_id: c.dealer?.dealer_id ?? null,
    internal_id: c.dealer?.internal_id ?? null,
    group_id: c.group_id,
    billing_customer_id: c.dealer?.billing_customer_id ?? c.grp?.billing_customer_id ?? null,
  };
}

export async function staffName(admin: any, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await admin.from("profiles").select("full_name, email").eq("id", id).maybeSingle();
  return data ? data.full_name || data.email : null;
}

/** Record + broadcast a pipeline stage change (caller already updated the row). */
export async function onStageChanged(admin: any, companyId: string, from: string | null, to: string, actor: string | null): Promise<void> {
  await admin.from("crm_activities").insert({
    company_id: companyId,
    type: "status_change",
    direction: "internal",
    subject: `Stage: ${from ? STAGE_LABEL[from as Stage] ?? from : "—"} → ${STAGE_LABEL[to as Stage] ?? to}`,
    metadata: { kind: "stage_change", from, to },
    actor_staff_id: actor,
  });
  const ref = await companyRef(admin, companyId);
  if (ref) await emitCrmEvent("company.stage_changed", { company: ref, from, to, changed_by: actor }, admin);
}

export async function onOwnerChanged(admin: any, companyId: string, from: string | null, to: string | null, actor: string | null): Promise<void> {
  const [fromName, toName] = await Promise.all([staffName(admin, from), staffName(admin, to)]);
  await admin.from("crm_activities").insert({
    company_id: companyId,
    type: "status_change",
    direction: "internal",
    subject: `Owner: ${fromName ?? "unassigned"} → ${toName ?? "unassigned"}`,
    metadata: { kind: "owner_change", from, to },
    actor_staff_id: actor,
  });
  const ref = await companyRef(admin, companyId);
  if (ref) await emitCrmEvent("company.owner_changed", {
    company: ref, from: from ? { staff_id: from, name: fromName } : null, to: to ? { staff_id: to, name: toName } : null, changed_by: actor,
  }, admin);
}

export async function emitContact(admin: any, event: "contact.created" | "contact.updated", contactId: string): Promise<void> {
  const { data: c } = await admin.from("crm_contacts")
    .select("id, company_id, user_id, first_name, last_name, email, phone, title, role_tag, deleted_at, updated_at")
    .eq("id", contactId).maybeSingle();
  if (!c) return;
  const ref = await companyRef(admin, c.company_id);
  await emitCrmEvent(event, { contact: { ...c, company_id: undefined }, company: ref }, admin);
}

/** [{address,label}] list from a request body; null when malformed. */
export function parseEmails(v: unknown): { address: string; label: string | null }[] | null {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  const out: { address: string; label: string | null }[] = [];
  for (const e of v) {
    const address = typeof e?.address === "string" ? e.address.trim().toLowerCase() : "";
    if (!address) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
    out.push({ address, label: typeof e?.label === "string" && e.label.trim() ? e.label.trim().slice(0, 40) : null });
  }
  return out;
}
