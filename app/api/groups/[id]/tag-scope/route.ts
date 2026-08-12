import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

type Params = { params: { id: string } };

/**
 * GET /api/groups/[id]/tag-scope?tag_ids=a,b
 *
 * Group-scoped tag availability + live scope preview WITHOUT a target user —
 * powers the invite form's Store Tags picker ("Will see N dealers" before
 * the invitation is even sent). Mirrors /api/users/[id]/store-scope's
 * resolution (available = tags in use on this group's dealers; resolved =
 * group ∩ tagged dealers), which needs an existing user; this one only
 * needs the group.
 *
 * Authz: super_admin any group; group_admin their own group.
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const allowed =
    claims.role === "super_admin" ||
    (claims.role === "group_admin" && claims.group_id === params.id);
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const tagIds = (req.nextUrl.searchParams.get("tag_ids") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminSupabaseClient() as any;

  const { data: groupDealers } = await admin
    .from("dealers").select("id, name").eq("group_id", params.id);
  const nameById = new Map<string, string>(
    (groupDealers ?? []).map((d: { id: string; name: string }) => [d.id, d.name]),
  );

  // tag_id → dealer ids (within the group)
  const dtByTag = new Map<string, Set<string>>();
  if (nameById.size) {
    const { data: dts } = await admin
      .from("dealer_tags").select("dealer_id, tag_id")
      .in("dealer_id", Array.from(nameById.keys()));
    for (const dt of (dts ?? []) as Array<{ dealer_id: string; tag_id: string }>) {
      const set = dtByTag.get(dt.tag_id) ?? new Set<string>();
      set.add(dt.dealer_id);
      dtByTag.set(dt.tag_id, set);
    }
  }

  // Named tags only — hidden per-user system scope tags (migration 142) are
  // never offered in the invite picker.
  const availableTagIds = Array.from(dtByTag.keys());
  let available: Array<{ id: string; name: string; color: string | null }> = [];
  if (availableTagIds.length) {
    const { data: tagRows } = await admin
      .from("tags").select("id, name, color").in("id", availableTagIds).eq("system", false);
    available = ((tagRows ?? []) as Array<{ id: string; name: string; color: string | null }>)
      .map((t) => ({ id: t.id, name: t.name, color: t.color ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Resolved scope for the REQUESTED selection: dealers in the group carrying
  // ANY of the tags (same union semantics as getJwtClaims scope resolution),
  // plus any DIRECTLY picked dealers (?dealer_ids=, migration 142).
  const resolvedIds = new Set<string>();
  for (const t of tagIds) {
    const set = dtByTag.get(t);
    if (set) set.forEach((d) => resolvedIds.add(d));
  }
  (req.nextUrl.searchParams.get("dealer_ids") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .forEach((d) => { if (nameById.has(d)) resolvedIds.add(d); });
  const dealers = Array.from(resolvedIds)
    .map((id) => ({ id, name: nameById.get(id) ?? id }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Full member roster for the invite form's direct dealer picker.
  const group_dealers = (groupDealers ?? [])
    .map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))
    .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

  return NextResponse.json({
    group_id: params.id,
    available,
    group_dealers,
    resolved: { count: dealers.length, dealers },
  });
}
