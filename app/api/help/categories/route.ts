import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

const SELECT = "id, name, sort_order, published, created_at, updated_at";

/**
 * GET /api/help/categories
 *   - Any authed user: published categories, in browse order.
 *   - super_admin with ?all=1: every category incl. unpublished (for the CMS).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const wantAll = claims.role === "super_admin" && req.nextUrl.searchParams.get("all") === "1";
  const admin = createAdminSupabaseClient();

  // help_categories isn't in the generated Database type yet (migration 159) —
  // use the loosely-typed client, matching the codebase convention.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (admin as any)
    .from("help_categories")
    .select(SELECT)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!wantAll) q = q.eq("published", true);

  const { data, error: dbErr } = await q;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}

/** POST /api/help/categories — create. super_admin only (the support team). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { name?: string; sort_order?: number; published?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: dbErr } = await (admin as any)
    .from("help_categories")
    .insert({
      name: name.slice(0, 80),
      sort_order: Number.isFinite(body.sort_order) ? body.sort_order : 0,
      published: body.published !== false,
      updated_at: new Date().toISOString(),
    })
    .select(SELECT)
    .single();

  if (dbErr) {
    if (dbErr.code === "23505") return NextResponse.json({ error: "A category with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}
