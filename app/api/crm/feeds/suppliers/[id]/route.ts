import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { DEFAULT_SETTINGS, supplierSettings } from "@/lib/crm/feeds/orders";
import { compilePattern } from "@/lib/crm/feeds/detect";
import { normEmail } from "@/lib/crm/inbox-match";
import { DMS_PROVIDERS, OTHER_PROVIDERS } from "@/lib/inventory-providers";
import { parseExtraFields } from "@/lib/crm/feeds/extra-fields";
import { UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

async function supplier(admin: any, id: string) {
  if (!UUID.test(id)) return null;
  const { data } = await admin.from("crm_companies").select("id, name, kind").eq("id", id).maybeSingle();
  return data?.kind === "feed_supplier" ? data : null;
}

/** GET /api/crm/feeds/suppliers/[id] — settings (+ provider list for the platform_provider picker). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const s = await supplier(admin, params.id);
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: tpls } = await admin.from("crm_email_templates").select("id, name, feed_kind").eq("supplier_company_id", s.id).eq("archived", false);
  return NextResponse.json({ supplier: s, settings: await supplierSettings(admin, s.id), overrides: tpls ?? [], providers: { dms: DMS_PROVIDERS, other: OTHER_PROVIDERS } });
}

/** PUT /api/crm/feeds/suppliers/[id] — crm_admin. Validates emails and the Feed ID regex. */
export async function PUT(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const s = await supplier(admin, params.id);
  if (!s) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const cur = (await supplierSettings(admin, s.id)) ?? DEFAULT_SETTINGS(s.id);
  const next: Record<string, any> = { ...cur };
  if ("request_method" in b) {
    if (!["email", "pdf", "api"].includes(b.request_method)) return NextResponse.json({ error: "Bad request method" }, { status: 400 });
    next.request_method = b.request_method;
  }
  if ("request_email" in b) {
    const e = b.request_email ? normEmail(String(b.request_email)) : null;
    if (b.request_email && !e) return NextResponse.json({ error: "Request email doesn't look right" }, { status: 400 });
    next.request_email = e;
  }
  if ("cc_emails" in b) {
    const list = (Array.isArray(b.cc_emails) ? b.cc_emails : String(b.cc_emails ?? "").split(/[,;\s]+/)).map((x: unknown) => String(x).trim()).filter(Boolean);
    const bad = list.filter((x: string) => !normEmail(x));
    if (bad.length) return NextResponse.json({ error: `Not an email: ${bad.join(", ")}` }, { status: 400 });
    next.cc_emails = Array.from(new Set(list.map((x: string) => normEmail(x)!)));
  }
  if ("feed_id_pattern" in b) {
    const p = typeof b.feed_id_pattern === "string" ? b.feed_id_pattern.trim() : "";
    if (p && !compilePattern(p)) return NextResponse.json({ error: "Feed ID pattern isn't a valid regular expression" }, { status: 400 });
    if (p.length > 300) return NextResponse.json({ error: "Feed ID pattern is too long" }, { status: 400 });
    next.feed_id_pattern = p || null;
  }
  if ("typical_turnaround_days" in b) {
    const n = Number(b.typical_turnaround_days);
    if (!Number.isInteger(n) || n < 0 || n > 60) return NextResponse.json({ error: "Turnaround is 0–60 business days" }, { status: 400 });
    next.typical_turnaround_days = n;
  }
  if ("pdf_field_map" in b) {
    if (!b.pdf_field_map || typeof b.pdf_field_map !== "object" || Array.isArray(b.pdf_field_map)) return NextResponse.json({ error: "PDF field map must be an object" }, { status: 400 });
    next.pdf_field_map = Object.fromEntries(Object.entries(b.pdf_field_map).filter(([k, v]) => k.trim() && typeof v === "string").slice(0, 200));
  }
  if ("domains" in b) {
    const list = (Array.isArray(b.domains) ? b.domains : String(b.domains ?? "").split(/[,;\s]+/)).map((x: unknown) => String(x).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    const bad = list.filter((d: string) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
    if (bad.length) return NextResponse.json({ error: `Not a domain: ${bad.join(", ")}` }, { status: 400 });
    next.domains = Array.from(new Set(list)).slice(0, 20);
  }
  if ("approval_phrases" in b) {
    if (!Array.isArray(b.approval_phrases)) return NextResponse.json({ error: "Approval phrases must be a list" }, { status: 400 });
    next.approval_phrases = b.approval_phrases.map((x: unknown) => String(x).trim()).filter((x: string) => x && x.length <= 60).slice(0, 20);
  }
  for (const k of ["cancellation_patterns"]) if (k in b) {
    if (!Array.isArray(b[k])) return NextResponse.json({ error: "Cancellation patterns must be a list" }, { status: 400 });
    const list = b[k].map((x: unknown) => String(x).trim()).filter(Boolean);
    const bad = list.filter((p: string) => p.length > 300 || !compilePattern(p));
    if (bad.length) return NextResponse.json({ error: `Not a valid regular expression: ${bad.join(" · ")}` }, { status: 400 });
    next[k] = list.slice(0, 10);
  }
  if ("case_number_pattern" in b) {
    const p = typeof b.case_number_pattern === "string" ? b.case_number_pattern.trim() : "";
    if (p && (p.length > 300 || !compilePattern(p))) return NextResponse.json({ error: "Case number pattern isn't a valid regular expression" }, { status: 400 });
    next.case_number_pattern = p || null;
  }
  if ("extra_fields" in b) {
    const raw = Array.isArray(b.extra_fields) ? b.extra_fields : null;
    if (!raw) return NextResponse.json({ error: "Order questions must be a JSON list" }, { status: 400 });
    const parsed = parseExtraFields(raw);
    if (parsed.length !== raw.length) return NextResponse.json({ error: "Some order questions are invalid (each needs a lower-case key and a label; choices need options)" }, { status: 400 });
    next.extra_fields = parsed;
  }
  for (const k of ["platform_provider", "notes"]) if (k in b) next[k] = typeof b[k] === "string" && b[k].trim() ? b[k].trim().slice(0, 2000) : null;
  for (const k of ["is_dms", "needs_review", "followup_new_thread", "feed_id_manual"]) if (k in b) next[k] = !!b[k];
  const { created_at: _c, updated_at: _u, ...row } = next;
  const { error: upErr } = await admin.from("crm_feed_supplier_settings").upsert({ ...row, company_id: s.id, updated_by: claims.sub }, { onConflict: "company_id" });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, settings: await supplierSettings(admin, s.id) });
}
