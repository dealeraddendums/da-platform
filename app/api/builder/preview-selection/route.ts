import { NextRequest, NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { parsePreviewSelection } from "@/lib/builder-preview";

/* eslint-disable @typescript-eslint/no-explicit-any */
const UUID = /^[0-9a-f-]{36}$/i;

// Template Builder preview selection (templates / group_templates.preview_products, migration 194).
// PREVIEW ONLY — the print pipeline never reads it. Same access as editing the template: a dealer
// template → whoever may act for its dealer; a group template → super_admin or that group's admin.
async function authorize(claims: JwtClaims, kind: string, id: string): Promise<{ table: "templates" | "group_templates" } | { error: NextResponse }> {
  const admin = createAdminSupabaseClient() as any;
  if (kind === "group") {
    const { data: t } = await admin.from("group_templates").select("group_id").eq("id", id).maybeSingle();
    if (!t) return { error: NextResponse.json({ error: "Template not found" }, { status: 404 }) };
    const ok = claims.role === "super_admin" || (claims.role === "group_admin" && claims.group_id === t.group_id);
    return ok ? { table: "group_templates" } : { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const { data: t } = await admin.from("templates").select("dealer_id").eq("id", id).maybeSingle();
  if (!t) return { error: NextResponse.json({ error: "Template not found" }, { status: 404 }) };
  const authz = await authorizeDealerAction(claims, t.dealer_id);
  return authz.ok ? { table: "templates" } : { error: authz.response };
}

/** GET ?template_id=&kind=dealer|group → { selection } */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const id = req.nextUrl.searchParams.get("template_id") ?? "", kind = req.nextUrl.searchParams.get("kind") ?? "dealer";
  if (!UUID.test(id)) return NextResponse.json({ error: "template_id required" }, { status: 400 });
  const a = await authorize(claims, kind, id);
  if ("error" in a) return a.error;
  const { data } = await (createAdminSupabaseClient() as any).from(a.table).select("preview_products").eq("id", id).maybeSingle();
  return NextResponse.json({ selection: parsePreviewSelection(data?.preview_products) });
}

/** PUT { template_id, kind, selection } — writes ONLY preview_products (never template_json / updated_at). */
export async function PUT(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const id = typeof b?.template_id === "string" ? b.template_id : "", kind = b?.kind === "group" ? "group" : "dealer";
  if (!UUID.test(id)) return NextResponse.json({ error: "template_id required" }, { status: 400 });
  const a = await authorize(claims, kind, id);
  if ("error" in a) return a.error;
  const selection = parsePreviewSelection(b?.selection);
  const { error: upErr } = await (createAdminSupabaseClient() as any).from(a.table).update({ preview_products: selection }).eq("id", id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ selection });
}
