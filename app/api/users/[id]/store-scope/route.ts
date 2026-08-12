/* eslint-disable @typescript-eslint/no-explicit-any */
// Store-scope preview for a group_user (Regional Manager): the GROUP's
// assignable tags + the dealers a given tag selection would resolve to, via the
// SAME group∩tag logic authorizeDealerAction uses (in-group AND the dealer
// carries one of the scope tags). Powers the "Sees N dealers" live preview in
// the Store Tags editor. super_admin, or group_admin for a group_user in their
// own group (Phase 3 slice, 2026-07-26 — matches the tags routes).
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeStoreTagsAccess } from "@/lib/user-authz";
import { getUserDirectScope } from "@/lib/tags";

type Params = { params: { id: string } };

/**
 * GET /api/users/[id]/store-scope[?tag_ids=a,b,c]
 *  → { group_id, available: TagLite[], resolved: { count, dealers: [{id,name}] } }
 *
 * `available` = tags currently in use on the user's group's dealers (the
 * assignable set for the dropdown). `resolved` = the in-group dealers that
 * carry any of the passed tag_ids (defaults to the user's saved tags when the
 * param is omitted). A user who isn't group-scoped returns empty sets.
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;

  const authz = await authorizeStoreTagsAccess(admin, claims, params.id);
  if (!authz.ok) return authz.response;

  const groupId: string | null = authz.target.group_id ?? null;
  if (!groupId) {
    return NextResponse.json({ group_id: null, available: [], resolved: { count: 0, dealers: [] } });
  }

  // Dealers in the group (id + name). dealer_tags.dealer_id is the dealers.id UUID.
  const { data: groupDealers } = await admin
    .from("dealers").select("id, name").eq("group_id", groupId);
  const groupDealerIds = new Set<string>((groupDealers ?? []).map((d: any) => d.id as string));
  const nameById = new Map<string, string>((groupDealers ?? []).map((d: any) => [d.id as string, d.name as string]));

  // dealer_tags for the group's dealers → which tags are in use + which dealers carry each.
  const dtByTag = new Map<string, Set<string>>(); // tag_id → dealer ids (in group)
  if (groupDealerIds.size) {
    const { data: dts } = await admin
      .from("dealer_tags").select("dealer_id, tag_id").in("dealer_id", Array.from(groupDealerIds));
    for (const dt of (dts ?? []) as Array<{ dealer_id: string; tag_id: string }>) {
      const set = dtByTag.get(dt.tag_id) ?? new Set<string>();
      set.add(dt.dealer_id);
      dtByTag.set(dt.tag_id, set);
    }
  }

  // Available NAMED tags = the non-system tags in use on this group's dealers.
  // Hidden per-user system scope tags (migration 142) are excluded — they're
  // driven by the direct dealer picker, never the tag dropdown.
  const availableTagIds = Array.from(dtByTag.keys());
  let available: Array<{ id: string; name: string; color: string | null }> = [];
  if (availableTagIds.length) {
    const { data: tagRows } = await admin
      .from("tags").select("id, name, color").in("id", availableTagIds).eq("system", false);
    available = (tagRows ?? [])
      .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  // The user's DIRECT dealer selection (their system tag's in-group dealers).
  const direct = await getUserDirectScope(admin, params.id);
  const directDealerIds = (direct?.dealerIds ?? []).filter((d) => groupDealerIds.has(d));

  // What to resolve: query params if present (live preview while editing),
  // else the user's saved state (user_tags — which already includes the
  // system tag, so the saved resolution needs no special casing).
  const tagParam = req.nextUrl.searchParams.get("tag_ids");
  const dealerParam = req.nextUrl.searchParams.get("dealer_ids");
  const seen = new Set<string>();
  if (tagParam !== null || dealerParam !== null) {
    const tagIds = (tagParam ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const tid of tagIds) {
      const ds = dtByTag.get(tid);
      if (ds) Array.from(ds).forEach((did) => { if (groupDealerIds.has(did)) seen.add(did); });
    }
    (dealerParam ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      .forEach((did) => { if (groupDealerIds.has(did)) seen.add(did); });
  } else {
    const { data: ut } = await admin.from("user_tags").select("tag_id").eq("user_id", params.id);
    for (const r of (ut ?? []) as Array<{ tag_id: string }>) {
      const ds = dtByTag.get(r.tag_id);
      if (ds) Array.from(ds).forEach((did) => { if (groupDealerIds.has(did)) seen.add(did); });
    }
  }
  const dealers = Array.from(seen)
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Full member roster for the direct dealer picker.
  const group_dealers = (groupDealers ?? [])
    .map((d: any) => ({ id: d.id as string, name: d.name as string }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  return NextResponse.json({
    group_id: groupId,
    available,
    group_dealers,
    direct_dealer_ids: directDealerIds,
    resolved: { count: dealers.length, dealers },
  });
}
