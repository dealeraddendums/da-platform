/* eslint-disable @typescript-eslint/no-explicit-any */
// user_tags isn't in the generated Supabase types yet (migration 109) —
// accessed via a loosely-typed admin client until those are regenerated.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeStoreTagsAccess } from "@/lib/user-authz";
import { getUserDirectScope, setUserDirectScope } from "@/lib/tags";

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
    .select("tags(id, name, color, system)")
    .eq("user_id", params.id);
  const tags = (data ?? [])
    .map((r: any) => r.tags)
    .filter((t: any) => t && !t.system) // hidden per-user scope tags never render as chips
    .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return NextResponse.json({ data: tags });
}

/**
 * PUT /api/users/[id]/tags  { tag_ids: string[], dealer_ids?: string[] }
 * Replace a user's scope. tag_ids = NAMED tags (reusable groupings);
 * dealer_ids (migration 142) = DIRECT dealer selection, materialized as the
 * user's hidden system tag via setUserDirectScope. Omitting dealer_ids leaves
 * the direct scope untouched (legacy callers). super_admin (any user), or
 * group_admin for a group_user in their own group. When the caller is a
 * group_admin, every named tag must be in use on THEIR group's dealers and
 * every picked dealer must be a member of their group.
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { tag_ids?: unknown; dealer_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!Array.isArray(body.tag_ids)) {
    return NextResponse.json({ error: "tag_ids array required" }, { status: 400 });
  }
  let tagIds = Array.from(new Set(body.tag_ids.filter((x): x is string => typeof x === "string")));
  const dealerIds = Array.isArray(body.dealer_ids)
    ? Array.from(new Set(body.dealer_ids.filter((x): x is string => typeof x === "string")))
    : undefined;

  const admin = createAdminSupabaseClient() as any;

  const authz = await authorizeStoreTagsAccess(admin, claims, params.id);
  if (!authz.ok) return authz.response;

  // Callers can never attach system scope tags by id — those are managed only
  // through dealer_ids (each user's own hidden tag).
  if (tagIds.length) {
    const { data: sysRows } = await admin
      .from("tags").select("id").in("id", tagIds).eq("system", true);
    const sysIds = new Set(((sysRows ?? []) as Array<{ id: string }>).map((r) => r.id));
    tagIds = tagIds.filter((t) => !sysIds.has(t));
  }

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

  // Direct dealer scope (migration 142) — reconcile the user's hidden system
  // tag first so the named reconcile below can preserve its user_tags link.
  if (dealerIds !== undefined) {
    const groupId = claims.role === "group_admin" ? claims.group_id : (authz.target.group_id ?? null);
    if (!groupId) {
      if (dealerIds.length) {
        return NextResponse.json({ error: "User is not group-scoped — cannot assign dealers" }, { status: 400 });
      }
    } else {
      const scopeErr = await setUserDirectScope(admin, {
        userId: params.id, groupId, dealerIds, actorId: claims.sub,
      });
      if (scopeErr) return NextResponse.json({ error: scopeErr }, { status: 400 });
    }
  }

  // Named-tag reconcile: replace every user_tags row EXCEPT the user's own
  // system scope tag (whose lifecycle setUserDirectScope owns).
  const direct = await getUserDirectScope(admin, params.id);
  let del = admin.from("user_tags").delete().eq("user_id", params.id);
  if (direct) del = del.neq("tag_id", direct.tagId);
  const { error: delErr } = await del;
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
    metadata: {
      user_id: params.id,
      tag_ids: tagIds,
      count: tagIds.length,
      ...(dealerIds !== undefined ? { dealer_ids: dealerIds, dealer_count: dealerIds.length } : {}),
    },
  });

  const { data } = await admin
    .from("user_tags")
    .select("tags(id, name, color, system)")
    .eq("user_id", params.id);
  const tags = (data ?? [])
    .map((r: any) => r.tags)
    .filter((t: any) => t && !t.system)
    .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return NextResponse.json({ data: tags });
}
