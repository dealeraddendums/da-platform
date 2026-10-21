import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { TEMPLATE_COLUMNS, derived, templateFields } from "@/lib/crm/templates";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/templates/[id] — any DA-CRM user. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data } = await admin.from("crm_email_templates").select(TEMPLATE_COLUMNS).eq("id", params.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ template: data });
}

/** PATCH /api/crm/templates/[id] (crm_admin) — any of name, category, subject, body_html, archived. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const parsed = templateFields(await req.json().catch(() => ({})), { create: false });
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { data: cur } = await admin.from("crm_email_templates").select("subject, body_html, import_report").eq("id", params.id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const patch: Record<string, unknown> = { ...parsed.fields, updated_by: claims.sub };
  if ("subject" in patch || "body_html" in patch) {
    const d = derived(String(patch.subject ?? cur.subject), String(patch.body_html ?? cur.body_html));
    patch.variables = d.variables;
    patch.needs_review = d.needs_review;
    // Keep the import history; refresh what's still unmapped.
    patch.import_report = { ...(cur.import_report ?? {}), unmapped: d.unknown.map((t) => ({ from: t, count: 1 })) };
  }
  const { data, error: e } = await admin.from("crm_email_templates").update(patch).eq("id", params.id).select(TEMPLATE_COLUMNS).single();
  if (e) {
    const dup = e.code === "23505";
    return NextResponse.json({ error: dup ? "A template with that name already exists" : e.message }, { status: dup ? 409 : 500 });
  }
  return NextResponse.json({ ok: true, template: data });
}
