/* eslint-disable @typescript-eslint/no-explicit-any */
// dealer_tags isn't in the generated Supabase types yet (migration 108) —
// accessed via a loosely-typed admin client until those are regenerated.
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { tagsForDealers } from "@/lib/tags";

type Params = { params: { id: string } };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Loaded =
  | { ok: false; response: NextResponse }
  | { ok: true; admin: any; claims: JwtClaims; dealerUuid: string };

/**
 * Resolve the dealer by [id] (UUID or text dealer_id) and authorize:
 * super_admin → any · dealer roles → own · group_admin → in-group
 * (authorizeDealerAction). Mirrors the logo route.
 */
async function loadAndAuthorize(id: string): Promise<Loaded> {
  const { claims, error } = await requireAuth();
  if (error) return { ok: false, response: error };

  const admin = createAdminSupabaseClient() as any;
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id")
    .eq(UUID_RE.test(id) ? "id" : "dealer_id", id)
    .maybeSingle();
  if (!dealer) return { ok: false, response: NextResponse.json({ error: "Dealer not found" }, { status: 404 }) };

  const authz = await authorizeDealerAction(claims, dealer.dealer_id as string);
  if (!authz.ok) return { ok: false, response: authz.response };

  return { ok: true, admin, claims, dealerUuid: dealer.id as string };
}

/** GET /api/dealers/[id]/tags → { data: TagLite[] } */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const res = await loadAndAuthorize(params.id);
  if (!res.ok) return res.response;

  const map = await tagsForDealers(res.admin, [res.dealerUuid]);
  return NextResponse.json({ data: map[res.dealerUuid] ?? [] });
}

/**
 * PUT /api/dealers/[id]/tags  { tag_ids: string[] }
 * Replace the dealer's tag set. super_admin (any) / group_admin (in-group).
 * Dealer roles cannot edit tags in v1.
 */
export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const res = await loadAndAuthorize(params.id);
  if (!res.ok) return res.response;
  const { admin, claims, dealerUuid } = res;

  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  // Replace: clear then insert the new set. Admin client (RLS bypass).
  const { error: delErr } = await admin.from("dealer_tags").delete().eq("dealer_id", dealerUuid);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  if (tagIds.length) {
    const { error: insErr } = await admin
      .from("dealer_tags")
      .insert(tagIds.map((tag_id) => ({ dealer_id: dealerUuid, tag_id, created_by: claims.sub })));
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  const map = await tagsForDealers(admin, [dealerUuid]);
  return NextResponse.json({ data: map[dealerUuid] ?? [] });
}
