import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { DEFAULT_SIGNATURE_TEMPLATE, type SignatureCta } from "@/lib/crm/signature";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/crm/signature — the company signature template + CTA (any DA-CRM user; the editor is crm_admin). */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const { data: s } = await (createAdminSupabaseClient() as any).from("crm_settings")
    .select("signature_template_html, signature_published_at, signature_cta").eq("id", true).maybeSingle();
  return NextResponse.json({
    template: s?.signature_template_html || DEFAULT_SIGNATURE_TEMPLATE,
    is_default: !s?.signature_template_html,
    default_template: DEFAULT_SIGNATURE_TEMPLATE,
    published_at: s?.signature_published_at ?? null,
    cta: { text: null, url: null, starts_on: null, ends_on: null, ...(s?.signature_cta ?? {}) },
  });
}

/**
 * PUT /api/crm/signature (crm_admin) — { template?: string | null (null = back to the default),
 * cta?: { text, url, starts_on, ends_on }, publish?: boolean }. Publishing switches every CRM email from
 * per-person signatures to the template; unpublishing goes back to them.
 */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: claims.sub };
  if ("template" in b) {
    if (b.template !== null && typeof b.template !== "string") return NextResponse.json({ error: "Bad template" }, { status: 400 });
    if (typeof b.template === "string" && b.template.length > 20000) return NextResponse.json({ error: "Template too long" }, { status: 400 });
    if (typeof b.template === "string" && !/\{\{\s*staff\.full_name\s*\}\}/.test(b.template)) return NextResponse.json({ error: "The template must include {{staff.full_name}}" }, { status: 400 });
    patch.signature_template_html = typeof b.template === "string" && b.template.trim() && b.template.trim() !== DEFAULT_SIGNATURE_TEMPLATE.trim() ? b.template : null;
  }
  if ("cta" in b) {
    const c = b.cta ?? {};
    const text = typeof c.text === "string" ? c.text.trim().slice(0, 140) : "";
    const url = typeof c.url === "string" ? c.url.trim().slice(0, 500) : "";
    if (url && !/^https?:\/\//i.test(url)) return NextResponse.json({ error: "The CTA link must start with http(s)://" }, { status: 400 });
    for (const k of ["starts_on", "ends_on"]) if (c[k] && !DAY.test(c[k])) return NextResponse.json({ error: `Bad ${k}` }, { status: 400 });
    if (c.starts_on && c.ends_on && c.starts_on > c.ends_on) return NextResponse.json({ error: "The CTA ends before it starts" }, { status: 400 });
    const cta: SignatureCta = { text: text || null, url: url || null, starts_on: c.starts_on || null, ends_on: c.ends_on || null };
    patch.signature_cta = cta;
  }
  if ("publish" in b) {
    patch.signature_published_at = b.publish ? new Date().toISOString() : null;
    patch.signature_published_by = b.publish ? claims.sub : null;
  }
  const { error: upErr } = await (createAdminSupabaseClient() as any).from("crm_settings").update(patch).eq("id", true);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return GET();
}
