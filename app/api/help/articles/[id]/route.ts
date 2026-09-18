import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { checkPdfUrl, isValidTourId, resolveCategory } from "@/lib/help-articles";

type Params = { params: { id: string } };
const SELECT_ADMIN =
  "id, slug, category, category_id, title, body, image_urls, pdf_url, product_fruits_tour_id, audience, sort_order, published, updated_by, updated_at, created_at";

/** GET /api/help/articles/[id] — published readable by any authed user; drafts super_admin only. */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (admin as any).from("help_articles").select(SELECT_ADMIN).eq("id", params.id).maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!data.published && claims.role !== "super_admin") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ data });
}

/** PUT /api/help/articles/[id] — edit. super_admin only. */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const admin = createAdminSupabaseClient();
  const patch: Record<string, unknown> = { updated_by: claims.sub, updated_at: new Date().toISOString() };

  if (body.category_id !== undefined) {
    const category = await resolveCategory(admin, body.category_id);
    if (!category) return NextResponse.json({ error: "Pick a category" }, { status: 400 });
    patch.category_id = category.id;
    // Keep the denormalized text label in step — the Help assistant reads it.
    patch.category = category.name;
  }
  if (typeof body.title === "string") patch.title = body.title.trim();
  // Rich HTML is stored VERBATIM (it is re-sanitized on render). Never
  // entity-encode here — that is what turned product descriptions into visible
  // literal tags (daacd3c).
  if (typeof body.body === "string") patch.body = body.body;
  if (Array.isArray(body.image_urls)) patch.image_urls = (body.image_urls as string[]).slice(0, 50);
  if (body.pdf_url !== undefined) {
    const pdf = checkPdfUrl(body.pdf_url);
    if (!pdf.ok) return NextResponse.json({ error: pdf.error }, { status: 422 });
    patch.pdf_url = pdf.value;
  }
  if (body.product_fruits_tour_id !== undefined) {
    const raw = String(body.product_fruits_tour_id ?? "").trim();
    if (raw && !isValidTourId(raw)) {
      return NextResponse.json({ error: "Tour ID may only contain letters, numbers, - and _" }, { status: 422 });
    }
    patch.product_fruits_tour_id = raw || null;
  }
  if (typeof body.audience === "string" && ["dealer", "group", "all"].includes(body.audience)) patch.audience = body.audience;
  if (Number.isFinite(body.sort_order as number)) patch.sort_order = body.sort_order;
  if (typeof body.published === "boolean") patch.published = body.published;
  if (typeof body.slug === "string" && body.slug.trim()) {
    patch.slug = body.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any).from("help_articles").update(patch).eq("id", params.id).select(SELECT_ADMIN).single();
  if (dbErr) {
    if (dbErr.code === "23505") return NextResponse.json({ error: "Slug already in use" }, { status: 409 });
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}

/** DELETE /api/help/articles/[id] — super_admin only. */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: dbErr } = await (admin as any).from("help_articles").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
