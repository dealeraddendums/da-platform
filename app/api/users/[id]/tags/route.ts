/* eslint-disable @typescript-eslint/no-explicit-any */
// user_tags isn't in the generated Supabase types yet (migration 109) —
// accessed via a loosely-typed admin client until those are regenerated.
import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/users/[id]/tags → { data: TagLite[] }
 * The scope tags assigned to a user (regional manager). super_admin only in
 * Phase 1 (Phase 3 adds group_admin self-service for their own group).
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;
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
 * Replace a user's scope tags. super_admin only (Phase 1).
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireSuperAdmin();
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

  // Confirm the target profile exists (avoid orphan rows on a typo'd id).
  const { data: profile } = await admin.from("profiles").select("id").eq("id", params.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { error: delErr } = await admin.from("user_tags").delete().eq("user_id", params.id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (tagIds.length) {
    const { error: insErr } = await admin
      .from("user_tags")
      .insert(tagIds.map((tag_id) => ({ user_id: params.id, tag_id, created_by: claims.sub })));
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

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
