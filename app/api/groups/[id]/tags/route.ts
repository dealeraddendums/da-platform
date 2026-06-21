/* eslint-disable @typescript-eslint/no-explicit-any */
// group_tags isn't in the generated Supabase types yet (migration 108) —
// accessed via a loosely-typed admin client until those are regenerated.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { tagsForGroups } from "@/lib/tags";

type Params = { params: { id: string } };

type Loaded =
  | { ok: false; response: NextResponse }
  | { ok: true; admin: any; claims: JwtClaims; groupUuid: string };

/**
 * Authorize a group-tag action against [id] (group UUID):
 * super_admin → any · group_admin → their OWN group only · others → 403.
 * (Groups have no authorizeDealerAction equivalent, so this is inline.)
 */
async function loadAndAuthorize(id: string): Promise<Loaded> {
  const { claims, error } = await requireAuth();
  if (error) return { ok: false, response: error };

  const admin = createAdminSupabaseClient() as any;
  const { data: group } = await admin.from("groups").select("id").eq("id", id).maybeSingle();
  if (!group) return { ok: false, response: NextResponse.json({ error: "Group not found" }, { status: 404 }) };

  const allowed =
    claims.role === "super_admin" ||
    (claims.role === "group_admin" && !!claims.group_id && claims.group_id === group.id);
  if (!allowed) return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };

  return { ok: true, admin, claims, groupUuid: group.id as string };
}

/** GET /api/groups/[id]/tags → { data: TagLite[] } */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const res = await loadAndAuthorize(params.id);
  if (!res.ok) return res.response;

  const map = await tagsForGroups(res.admin, [res.groupUuid]);
  return NextResponse.json({ data: map[res.groupUuid] ?? [] });
}

/**
 * PUT /api/groups/[id]/tags  { tag_ids: string[] }
 * Replace the group's tag set. super_admin (any) / group_admin (own group).
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const res = await loadAndAuthorize(params.id);
  if (!res.ok) return res.response;
  const { admin, claims, groupUuid } = res;

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

  const { error: delErr } = await admin.from("group_tags").delete().eq("group_id", groupUuid);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (tagIds.length) {
    const { error: insErr } = await admin
      .from("group_tags")
      .insert(tagIds.map((tag_id) => ({ group_id: groupUuid, tag_id, created_by: claims.sub })));
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const map = await tagsForGroups(admin, [groupUuid]);
  return NextResponse.json({ data: map[groupUuid] ?? [] });
}
