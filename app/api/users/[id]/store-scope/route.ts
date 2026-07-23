/* eslint-disable @typescript-eslint/no-explicit-any */
// Store-scope preview for a group_user (Regional Manager): the GROUP's
// assignable tags + the dealers a given tag selection would resolve to, via the
// SAME group∩tag logic authorizeDealerAction uses (in-group AND the dealer
// carries one of the scope tags). Powers the "Sees N dealers" live preview in
// the Store Tags editor. super_admin only (Phase 1 — matches the tags routes).
import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

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
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient() as any;

  const { data: profile } = await admin
    .from("profiles").select("id, group_id, role").eq("id", params.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const groupId: string | null = profile.group_id ?? null;
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

  // Available tags = the tags in use on this group's dealers.
  const availableTagIds = Array.from(dtByTag.keys());
  let available: Array<{ id: string; name: string; color: string | null }> = [];
  if (availableTagIds.length) {
    const { data: tagRows } = await admin
      .from("tags").select("id, name, color").in("id", availableTagIds);
    available = (tagRows ?? [])
      .map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? null }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));
  }

  // Which tag_ids to resolve: query param if present, else the user's saved tags.
  const param = req.nextUrl.searchParams.get("tag_ids");
  let tagIds: string[];
  if (param !== null) {
    tagIds = param.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const { data: ut } = await admin.from("user_tags").select("tag_id").eq("user_id", params.id);
    tagIds = (ut ?? []).map((r: any) => r.tag_id as string);
  }

  // Resolve group ∩ tags: in-group dealers carrying any selected tag.
  const seen = new Set<string>();
  for (const tid of tagIds) {
    const ds = dtByTag.get(tid);
    if (ds) Array.from(ds).forEach((did) => { if (groupDealerIds.has(did)) seen.add(did); });
  }
  const dealers = Array.from(seen)
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ group_id: groupId, available, resolved: { count: dealers.length, dealers } });
}
