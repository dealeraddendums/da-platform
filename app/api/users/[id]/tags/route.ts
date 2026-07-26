/* eslint-disable @typescript-eslint/no-explicit-any */
// user_tags isn't in the generated Supabase types yet (migration 109) —
// accessed via a loosely-typed admin client until those are regenerated.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeStoreTagsAccess } from "@/lib/user-authz";

type Params = { params: { id: string } };

/**
 * GET /api/users/[id]/tags → { data: TagLite[] }
 * The scope tags assigned to a user (regional manager). super_admin, or
 * group_admin for a group_user in their own group (Phase 3 slice, 2026-07-26).
 * group_user callers are refused — they cannot edit their own scope.
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;
  const authz = await authorizeStoreTagsAccess(admin, claims, params.id);
  if (!authz.ok) return authz.response;
  const { data } = await admin
    .from("user_tags")
    .select("tags(id, name, color)")
    .eq("user_id", params.id);
  const tags = (data ?? [])
    .map((r: any) => r.tags)
    .filter(Boolean)
    .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return NextResponse.json({ data: tags });
}

/**
 * PUT /api/users/[id]/tags  { tag_ids: string[] }
 * Replace a user's scope tags. super_admin (any user), or group_admin for a
 * group_user in their own group. When the caller is a group_admin, every
 * assigned tag must be in use on THEIR group's dealers — they cannot attach
 * a foreign group's tags to widen a manager's scope.
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { tag_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.tag_ids)) {
    return NextResponse.json({ error: "tag_ids array required" }, { status: 400 });
  }
  const tagIds = Array.from(new Set(body.tag_ids.filter((x): x is string => typeof x === "string")));

  const admin = createAdminSupabaseClient() as any;

  const authz = await authorizeStoreTagsAccess(admin, claims, params.id);
  if (!authz.ok) return authz.response;

  // group_admin: restrict assignable tags to those in use on their own group's
  // dealers (the same set the store-scope dropdown offers). A tag id outside
  // that set is either another group's or unused — refuse rather than silently
  // scope a manager to dealers the caller can't see.
  if (claims.role === "group_admin" && tagIds.length) {
    const { data: groupDealers } = await admin
      .from("dealers").select("id").eq("group_id", claims.group_id);
    const ids = (groupDealers ?? []).map((d: any) => d.id as string);
    const usable = new Set<string>();
    if (ids.length) {
      const { data: dts } = await admin
        .from("dealer_tags").select("tag_id").in("dealer_id", ids).in("tag_id", tagIds);
      for (const r of (dts ?? []) as Array<{ tag_id: string }>) usable.add(r.tag_id);
    }
    const foreign = tagIds.filter((t) => !usable.has(t));
    if (foreign.length) {
      return NextResponse.json({ error: "One or more tags are not in use on your group's dealers" }, { status: 400 });
    }
  }

  const { error: delErr } = await admin.from("user_tags").delete().eq("user_id", params.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (tagIds.length) {
    const { error: insErr } = await admin
      .from("user_tags")
      .insert(tagIds.map((tag_id) => ({ user_id: params.id, tag_id, created_by: claims.sub })));
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // Audit the scope change (fire-and-forget; must be awaited or supabase-js
  // never executes it — see lib/db fireWrite note).
  await admin.from("admin_audit").insert({
    admin_user_id: claims.sub,
    action: "user_scope_tags_set",
    metadata: { user_id: params.id, tag_ids: tagIds, count: tagIds.length },
  });

  const { data } = await admin
    .from("user_tags")
    .select("tags(id, name, color)")
    .eq("user_id", params.id);
  const tags = (data ?? [])
    .map((r: any) => r.tags)
    .filter(Boolean)
    .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return NextResponse.json({ data: tags });
}
