import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { normEmail } from "@/lib/crm/inbox-match";
import { str } from "@/lib/crm/feeds/http";
import { parseExtraFields } from "@/lib/crm/feeds/extra-fields";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/feeds/suppliers — feed suppliers for the pickers, with their request method / readiness. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const [{ data: cos }, { data: st }] = await Promise.all([
    admin.from("crm_companies").select("id, name").eq("kind", "feed_supplier").order("name"),
    admin.from("crm_feed_supplier_settings").select("company_id, request_method, request_email, needs_review, platform_provider, is_dms, extra_fields"),
  ]);
  const by = Object.fromEntries((st ?? []).map((s: any) => [s.company_id, { ...s, extra_fields: parseExtraFields(s.extra_fields) }]));
  return NextResponse.json({ suppliers: (cos ?? []).map((c: any) => ({ id: c.id, name: c.name, ...(by[c.id] ?? { request_method: "email", request_email: null, needs_review: true }) })) });
}

/**
 * POST /api/crm/feeds/suppliers { name, request_email? } — inline "Add supplier"
 * from Start feed order. Any DA-CRM user; it starts as needs_review until a
 * crm_admin checks its Settings tab.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const name = str(b?.name, 120);
  if (!name) return NextResponse.json({ error: "Supplier name required" }, { status: 400 });
  const email = b?.request_email ? normEmail(String(b.request_email)) : null;
  if (b?.request_email && !email) return NextResponse.json({ error: "That email doesn't look right" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { data: dup } = await admin.from("crm_companies").select("id, name").eq("kind", "feed_supplier").ilike("name", name.replace(/[%_\\]/g, (c) => `\\${c}`)).maybeSingle();
  if (dup) return NextResponse.json({ ok: true, supplier: dup, existed: true });
  const { data: co, error: insErr } = await admin.from("crm_companies").insert({ kind: "feed_supplier", name }).select("id, name").single();
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  await admin.from("crm_feed_supplier_settings").insert({ company_id: co.id, request_email: email, platform_provider: name, needs_review: true, updated_by: claims.sub });
  return NextResponse.json({ ok: true, supplier: co });
}
