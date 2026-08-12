/* eslint-disable @typescript-eslint/no-explicit-any */
// The tags/dealer_tags/group_tags tables aren't in the generated Supabase types
// yet (migration 108) — accessed via a loosely-typed admin client until then.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { paletteKeyForName, TAG_PALETTE_KEYS } from "@/lib/tags";

/**
 * GET /api/tags?q=
 * List tags with dealer_count + group_count, ordered by name. `q` filters by
 * name for the picker autocomplete. Any authenticated user.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  // system=true tags are hidden per-user scope tags (migration 142) — never
  // listed in pickers/filters.
  let query = admin.from("tags").select("id, name, color").eq("system", false).order("name");
  if (q) query = query.ilike("name", `%${q}%`);
  const { data: tags, error: dbErr } = await query;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  const tagIds = (tags ?? []).map((t: any) => t.id as string);
  const dealerCount: Record<string, number> = {};
  const groupCount: Record<string, number> = {};

  if (tagIds.length) {
    const [{ data: dt }, { data: gt }] = await Promise.all([
      admin.from("dealer_tags").select("tag_id").in("tag_id", tagIds),
      admin.from("group_tags").select("tag_id").in("tag_id", tagIds),
    ]);
    for (const r of dt ?? []) {
      const id = (r as { tag_id: string }).tag_id;
      dealerCount[id] = (dealerCount[id] ?? 0) + 1;
    }
    for (const r of gt ?? []) {
      const id = (r as { tag_id: string }).tag_id;
      groupCount[id] = (groupCount[id] ?? 0) + 1;
    }
  }

  const data = (tags ?? []).map((t: any) => {
    const tag = t as { id: string; name: string; color: string | null };
    return {
      id: tag.id,
      name: tag.name,
      color: tag.color,
      dealer_count: dealerCount[tag.id] ?? 0,
      group_count: groupCount[tag.id] ?? 0,
    };
  });

  return NextResponse.json({ data });
}

/**
 * POST /api/tags  { name, color? }
 * Create a tag (super_admin + group_admin). Normalizes/dedupes by lower(name):
 * if a tag already exists (case-insensitive), the EXISTING one is returned —
 * never a duplicate. Color is constrained to the established badge palette;
 * when omitted, a deterministic palette key is assigned from the name.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { name?: string; color?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  // "__scope:" is reserved for hidden per-user system tags (migration 142).
  if (name.toLowerCase().startsWith("__scope:")) {
    return NextResponse.json({ error: "That tag name is reserved" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient() as any;

  // Dedupe by lower(name) — return the existing tag if one matches.
  const { data: existing } = await admin
    .from("tags")
    .select("id, name, color")
    .ilike("name", name)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ data: existing });
  }

  const color =
    body.color && (TAG_PALETTE_KEYS as readonly string[]).includes(body.color)
      ? body.color
      : paletteKeyForName(name);

  const { data, error: insErr } = await admin
    .from("tags")
    .insert({ name, color, created_by: claims.sub })
    .select("id, name, color")
    .single();

  // Lost the race against the unique(lower(name)) index — re-fetch + return it.
  if (insErr) {
    if (insErr.code === "23505") {
      const { data: raced } = await admin
        .from("tags")
        .select("id, name, color")
        .ilike("name", name)
        .maybeSingle();
      if (raced) return NextResponse.json({ data: raced });
    }
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ data }, { status: 201 });
}
