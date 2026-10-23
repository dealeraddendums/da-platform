import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { normalizePhone } from "@/lib/crm/phone";
import { STAGES, onOwnerChanged, onStageChanged, ownerForStage, parseEmails } from "@/lib/crm/companies";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/crm/companies/[id] — any of:
 *   pipeline_stage (dealers)   → status_change activity + company.stage_changed
 *   owner_staff_id (crm_admin) → status_change activity + company.owner_changed
 *   brands: string[] (dealers), emails, phone, website, notes, name (partners)
 * Moving a dealer back into 'trial' restarts the trial clock today. Owners are
 * for Trial / Setup & training only: converting to paying (Current) clears it.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, perms, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  const { data: c } = await admin.from("crm_companies").select("id, kind, pipeline_stage, owner_staff_id").eq("id", params.id).maybeSingle();
  if (!c) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  const isDealer = c.kind === "dealer";
  const isPartner = c.kind === "vendor" || c.kind === "feed_supplier";

  const patch: Record<string, unknown> = {};
  if ("pipeline_stage" in b) {
    if (!isDealer) return NextResponse.json({ error: "Only dealers have a pipeline stage" }, { status: 400 });
    if (!(STAGES as readonly string[]).includes(b.pipeline_stage)) return NextResponse.json({ error: "Unknown stage" }, { status: 400 });
    if (b.pipeline_stage !== c.pipeline_stage) {
      patch.pipeline_stage = b.pipeline_stage;
      if (b.pipeline_stage === "trial") { patch.trial_started_at = new Date().toISOString(); patch.trial_day = 1; patch.trial_flag = null; }
      else { patch.trial_day = null; patch.trial_flag = null; patch.trial_ends_on = null; }
    }
  }
  let requestedOwner: { owner: string | null } | undefined;
  if ("owner_staff_id" in b) {
    if (!perms.crmAdmin) return NextResponse.json({ error: "Changing the owner needs crm_admin" }, { status: 403 });
    const owner = b.owner_staff_id || null;
    if (owner) {
      const { data: sp } = await admin.from("staff_permissions").select("user_id").eq("user_id", owner).in("permission", ["crm", "crm_admin"]).limit(1);
      if (!sp?.length) return NextResponse.json({ error: "Owner must be a DA-CRM team member" }, { status: 400 });
    }
    requestedOwner = { owner };
  }
  if (isDealer) {
    const o = ownerForStage((patch.pipeline_stage as string | undefined) ?? c.pipeline_stage, c.owner_staff_id, requestedOwner);
    if (o.error) return NextResponse.json({ error: o.error }, { status: 400 });
    if ("owner" in o) patch.owner_staff_id = o.owner;
  } else if (requestedOwner && requestedOwner.owner !== c.owner_staff_id) {
    patch.owner_staff_id = requestedOwner.owner;
  }
  if ("phone" in b) {
    const phone = b.phone ? normalizePhone(b.phone) : null;
    if (b.phone && !phone) return NextResponse.json({ error: "Phone number isn't valid" }, { status: 400 });
    patch.phone = phone;
  }
  if ("emails" in b) {
    const emails = parseEmails(b.emails);
    if (emails === null) return NextResponse.json({ error: "emails must be [{address, label}]" }, { status: 400 });
    patch.emails = emails;
  }
  for (const k of ["website", "notes"] as const) {
    if (k in b) patch[k] = typeof b[k] === "string" && b[k].trim() ? b[k].trim() : null;
  }
  if ("name" in b) {
    if (!isPartner) return NextResponse.json({ error: "Dealer and group names come from the platform record" }, { status: 400 });
    if (typeof b.name !== "string" || !b.name.trim()) return NextResponse.json({ error: "name can't be blank" }, { status: 400 });
    patch.name = b.name.trim();
  }

  let brandsChanged = false;
  if ("brands" in b) {
    if (!isDealer) return NextResponse.json({ error: "Only dealers have brands" }, { status: 400 });
    if (!Array.isArray(b.brands)) return NextResponse.json({ error: "brands must be an array" }, { status: 400 });
    const want = Array.from(new Set(b.brands.filter((x: unknown) => typeof x === "string"))) as string[];
    const { data: known } = await admin.from("crm_brands").select("brand").in("brand", want.length ? want : ["__none__"]);
    if ((known ?? []).length !== want.length) return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    await admin.from("crm_company_brands").delete().eq("company_id", c.id);
    if (want.length) await admin.from("crm_company_brands").insert(want.map((brand) => ({ company_id: c.id, brand })));
    brandsChanged = true;
  }

  if (!Object.keys(patch).length && !brandsChanged) return NextResponse.json({ ok: true, unchanged: true });
  if (Object.keys(patch).length) {
    const { error: upErr } = await admin.from("crm_companies").update(patch).eq("id", c.id);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  }
  if ("pipeline_stage" in patch) await onStageChanged(admin, c.id, c.pipeline_stage, patch.pipeline_stage as string, claims.sub);
  if ("owner_staff_id" in patch) await onOwnerChanged(admin, c.id, c.owner_staff_id, patch.owner_staff_id as string | null, claims.sub);
  return NextResponse.json({ ok: true });
}
