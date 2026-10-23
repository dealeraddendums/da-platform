import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { duplicateMessage, feedFolderFields, TEMPLATE_COLUMNS, derived, templateFields } from "@/lib/crm/templates";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/templates?q=&category=&archived=1 — any DA-CRM user. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const sp = req.nextUrl.searchParams;
  const admin = createAdminSupabaseClient() as any;
  let q = admin.from("crm_email_templates").select(TEMPLATE_COLUMNS).order("category", { nullsFirst: false }).order("name").limit(500);
  q = q.eq("archived", sp.get("archived") === "1");
  const term = (sp.get("q") ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 80);
  if (term) q = q.or(`name.ilike.%${term}%,subject.ilike.%${term}%`);
  if (sp.get("category")) q = q.eq("category", sp.get("category"));
  const { data, error: e } = await q;
  if (e) return NextResponse.json({ error: e.message }, { status: 500 });
  return NextResponse.json({ templates: data ?? [] });
}

/** POST /api/crm/templates (crm_admin) — { name, category?, subject, body_html }. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const body = await req.json().catch(() => ({}));
  const parsed = templateFields(body, { create: true });
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const f = parsed.fields as { subject: string; body_html: string };
  const d = derived(f.subject, f.body_html);
  const admin = createAdminSupabaseClient() as any;
  const feed = await feedFolderFields(admin, body);
  if ("error" in feed) return NextResponse.json({ error: feed.error }, { status: 400 });
  Object.assign(parsed.fields, feed.fields);
  const { data, error: e } = await admin.from("crm_email_templates").insert({
    ...parsed.fields, variables: d.variables, needs_review: d.needs_review,
    import_report: d.unknown.length ? { unmapped: d.unknown.map((t) => ({ from: t, count: 1 })) } : null,
    created_by: claims.sub, updated_by: claims.sub,
  }).select(TEMPLATE_COLUMNS).single();
  if (e) {
    const dup = e.code === "23505";
    return NextResponse.json({ error: dup ? duplicateMessage(e) : e.message }, { status: dup ? 409 : 500 });
  }
  return NextResponse.json({ ok: true, template: data });
}
