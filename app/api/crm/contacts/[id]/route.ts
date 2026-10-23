import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { contactFields, linkPlatformUser } from "@/lib/crm/contact-input";
import { emitContact } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/crm/contacts/[id] — edit any of first_name, last_name, email,
 * phone, title, role_tag; { deleted: true } soft-deletes; { verified: true } clears a record contact's
 * "Verify" flag (migration 190) so email matching treats it as a real contact; { company_id } moves a
 * (non-user) contact to another company and re-checks its domain there (+ all_copies: true merges the
 * same person's other flagged copies into it). Emits contact.updated.
 * A platform user's contact (user_id set) follows the user (migration 188): its email changes and its
 * removal happen on the platform, so both are refused here.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  const { data: c } = await admin.from("crm_contacts").select("id, company_id, user_id, email").eq("id", params.id).is("deleted_at", null).maybeSingle();
  if (!c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  if (c.user_id && b?.deleted === true) {
    return NextResponse.json({ error: "This contact is a platform user — disable or remove the user in DA Users instead" }, { status: 409 });
  }

  const patch: Record<string, unknown> = {};
  let mergeIds: string[] = [];
  if (b?.deleted === true) patch.deleted_at = new Date().toISOString();
  else if (b?.verified === true) Object.assign(patch, { verified_at: new Date().toISOString(), verified_by: claims.sub });
  else if (typeof b?.company_id === "string") {
    // Move to another company (the Verify panel's "Move to…"). A platform user's contact follows the user.
    if (c.user_id) return NextResponse.json({ error: "This contact is a platform user — change their dealer or group in DA Users" }, { status: 409 });
    if (!/^[0-9a-f-]{36}$/i.test(b.company_id)) return NextResponse.json({ error: "Bad company" }, { status: 400 });
    const { data: target } = await admin.from("crm_companies").select("id").eq("id", b.company_id).maybeSingle();
    if (!target) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    if (b.company_id === c.company_id) return NextResponse.json({ error: "Already at that company" }, { status: 400 });
    // Re-judge the domain at the new company (a vendor / group with no domain evidence → no flag).
    const { data: reason } = await admin.rpc("crm_contact_verify_reason", { p_company: b.company_id, p_email: c.email });
    Object.assign(patch, { company_id: b.company_id, verify_reason: reason ?? null, verified_at: null, verified_by: null });
    // all_copies: the same person flagged at other companies (a vendor on several dealer records) moves
    // too — merged into this one contact (their activities / calls / threads repointed, copies retired).
    if (b.all_copies === true && c.email) {
      const { data: copies } = await admin.from("crm_contacts").select("id").eq("email", c.email).is("deleted_at", null)
        .is("user_id", null).neq("id", c.id).not("verify_reason", "is", null).is("verified_at", null);
      mergeIds = (copies ?? []).map((x: any) => x.id);
    }
  }
  else {
    const parsed = contactFields(b, { requireFirstName: false });
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (c.user_id && "email" in parsed.fields && (parsed.fields.email ?? null) !== (c.email ?? null)) {
      return NextResponse.json({ error: "This contact is a platform user — change the email in DA Users" }, { status: 409 });
    }
    Object.assign(patch, parsed.fields);
    if (typeof parsed.fields.email === "string" && !c.user_id) patch.user_id = await linkPlatformUser(admin, c.company_id, parsed.fields.email);
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const { error: upErr } = await admin.from("crm_contacts").update(patch).eq("id", c.id);
  if (upErr) {
    const dup = upErr.code === "23505";
    return NextResponse.json({ error: dup ? "A contact with that email already exists at that company" : upErr.message }, { status: dup ? 409 : 500 });
  }
  for (const from of mergeIds) await admin.rpc("crm_merge_contact", { p_from: from, p_into: c.id });
  await emitContact(admin, "contact.updated", c.id);
  return NextResponse.json({ ok: true, merged: mergeIds.length });
}
