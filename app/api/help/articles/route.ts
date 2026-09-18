import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { checkPdfUrl, isValidTourId, resolveCategory } from "@/lib/help-articles";

const COMMON = "id, slug, category, category_id, title, body, image_urls, pdf_url, product_fruits_tour_id, audience, sort_order, updated_at";
const SELECT_PUBLIC = COMMON;
const SELECT_ADMIN = `${COMMON}, published, updated_by, created_at`;

/**
 * GET /api/help/articles
 *   - Any authed user: published articles (audience dealer/all; group_admin also 'group').
 *   - super_admin with ?all=1: every article incl. drafts (for the CMS).
 *   - Optional ?category_id= and ?q= (title/body search).
 *
 * Dealers browse by CATEGORY, so an article in an unpublished category is hidden
 * even when the article itself is published — that is what "hide a section while
 * it is being written" means. Filtering happens here rather than in the query
 * because PostgREST can't express "embedded row is published OR is null".
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const admin = createAdminSupabaseClient();
  const isSuper = claims.role === "super_admin";
  const wantAll = isSuper && sp.get("all") === "1";

  // help_articles isn't in the generated Database type yet (migration 091/159) —
  // use the loosely-typed client, matching the codebase convention.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from("help_articles")
    .select(wantAll ? SELECT_ADMIN : SELECT_PUBLIC)
    .order("sort_order", { ascending: true })
    .order("title", { ascending: true });

  if (!wantAll) {
    q = q.eq("published", true);
    const audiences = claims.role === "group_admin" ? ["dealer", "all", "group"] : ["dealer", "all"];
    q = q.in("audience", audiences);
  }

  const categoryId = sp.get("category_id");
  if (categoryId) q = q.eq("category_id", categoryId);

  const search = sp.get("q")?.trim();
  if (search) {
    const safe = search.replace(/[%,]/g, " ");
    q = q.or(`title.ilike.%${safe}%,body.ilike.%${safe}%`);
  }

  const { data, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  let rows = (data ?? []) as Array<{ category_id: string | null }>;
  if (!wantAll) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cats } = await (admin as any)
      .from("help_categories").select("id").eq("published", true);
    const live = new Set(((cats ?? []) as Array<{ id: string }>).map((c) => c.id));
    // An article with no category (shouldn't happen post-159) still shows, so a
    // data gap never silently swallows published content.
    rows = rows.filter((a) => !a.category_id || live.has(a.category_id));
  }

  return NextResponse.json({ data: rows });
}

/** POST /api/help/articles — create. super_admin only (the support team is super_admin). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: {
    slug?: string; category_id?: string; title?: string; body?: string;
    image_urls?: string[]; pdf_url?: string; product_fruits_tour_id?: string;
    audience?: string; sort_order?: number; published?: boolean;
  };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  if (!body.title?.trim()) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const category = await resolveCategory(admin, body.category_id);
  if (!category) return NextResponse.json({ error: "Pick a category" }, { status: 400 });

  const pdf = checkPdfUrl(body.pdf_url);
  if (!pdf.ok) return NextResponse.json({ error: pdf.error }, { status: 422 });

  const tourRaw = (body.product_fruits_tour_id ?? "").trim();
  if (tourRaw && !isValidTourId(tourRaw)) {
    return NextResponse.json({ error: "Tour ID may only contain letters, numbers, - and _" }, { status: 422 });
  }

  const slug = (body.slug?.trim() || body.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const audience = ["dealer", "group", "all"].includes(body.audience ?? "") ? body.audience : "dealer";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("help_articles")
    .insert({
      slug,
      category_id: category.id,
      category: category.name,
      title: body.title.trim(),
      body: body.body ?? "",
      image_urls: Array.isArray(body.image_urls) ? body.image_urls.slice(0, 50) : [],
      pdf_url: pdf.value,
      product_fruits_tour_id: tourRaw || null,
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
