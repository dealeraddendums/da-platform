import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };
const SELECT_ADMIN = "id, slug, category, title, body, image_urls, audience, sort_order, published, updated_by, updated_at, created_at";

/** GET /api/help/articles/[id] — published readable by any authed user; drafts super_admin only. */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
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

  const patch: Record<string, unknown> = { updated_by: claims.sub, updated_at: new Date().toISOString() };
  if (typeof body.category === "string") patch.category = body.category.trim();
  if (typeof body.title === "string") patch.title = body.title.trim();
  if (typeof body.body === "string") patch.body = body.body;
  if (Array.isArray(body.image_urls)) patch.image_urls = (body.image_urls as string[]).slice(0, 50);
  if (typeof body.audience === "string" && ["dealer", "group", "all"].includes(body.audience)) patch.audience = body.audience;
  if (Number.isFinite(body.sort_order as number)) patch.sort_order = body.sort_order;
  if (typeof body.published === "boolean") patch.published = body.published;
  if (typeof body.slug === "string" && body.slug.trim()) {
    patch.slug = body.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  }

  const admin = createAdminSupabaseClient();
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
  const { error: dbErr } = await (admin as any).from("help_articles").delete().eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
