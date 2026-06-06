import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

const SELECT_PUBLIC = "id, slug, category, title, body, image_urls, audience, sort_order, updated_at";
const SELECT_ADMIN = "id, slug, category, title, body, image_urls, audience, sort_order, published, updated_by, updated_at, created_at";

/**
 * GET /api/help/articles
 *   - Any authed user: published articles (audience dealer/all; group_admin also 'group').
 *   - super_admin with ?all=1: every article incl. drafts (for the CMS).
 *   - Optional ?category= and ?q= (title/body search).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const admin = createAdminSupabaseClient();
  const isSuper = claims.role === "super_admin";
  const wantAll = isSuper && sp.get("all") === "1";

  // help_articles isn't in the generated Database type yet (migration 091) —
  // use the loosely-typed client, matching the codebase convention.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from("help_articles")
    .select(wantAll ? SELECT_ADMIN : SELECT_PUBLIC)
    .order("category", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });

  if (!wantAll) {
    q = q.eq("published", true);
    const audiences = claims.role === "group_admin" ? ["dealer", "all", "group"] : ["dealer", "all"];
    q = q.in("audience", audiences);
  }

  const category = sp.get("category");
  if (category) q = q.eq("category", category);

  const search = sp.get("q")?.trim();
  if (search) {
    const safe = search.replace(/[%,]/g, " ");
    q = q.or(`title.ilike.%${safe}%,body.ilike.%${safe}%`);
  }

  const { data, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/** POST /api/help/articles — create. super_admin only (the support team is super_admin). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    slug?: string; category?: string; title?: string; body?: string;
    image_urls?: string[]; audience?: string; sort_order?: number; published?: boolean;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (!body.category?.trim()) return NextResponse.json({ error: "category is required" }, { status: 400 });
  const slug = (body.slug?.trim() || body.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const audience = ["dealer", "group", "all"].includes(body.audience ?? "") ? body.audience : "dealer";

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("help_articles")
    .insert({
      slug,
      category: body.category.trim(),
      title: body.title.trim(),
      body: body.body ?? "",
      image_urls: Array.isArray(body.image_urls) ? body.image_urls.slice(0, 50) : [],
      audience,
      sort_order: Number.isFinite(body.sort_order) ? body.sort_order : 0,
      published: body.published === true,
      updated_by: claims.sub,
      updated_at: new Date().toISOString(),
    })
    .select(SELECT_ADMIN)
    .single();

  if (dbErr) {
    if (dbErr.message.includes("duplicate") || dbErr.code === "23505") {
      return NextResponse.json({ error: "An article with that slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
