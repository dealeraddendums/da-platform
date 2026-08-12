/* eslint-disable @typescript-eslint/no-explicit-any */
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * Shared tag helpers (Dealer & Group Tagging v1 — docs/dealer-group-tagging.md).
 *
 * One namespace (`tags`) joined to dealers (`dealer_tags`) and groups
 * (`group_tags`). All writes go through the role-gated API on the admin client;
 * these helpers are read/utility only.
 *
 * NOTE: the tags/dealer_tags/group_tags tables aren't in the generated Supabase
 * types yet (migration 108). Until the types are regenerated, these tables are
 * accessed through a loosely-typed view of the admin client — `(admin as any)`
 * — mirroring the existing pattern elsewhere (e.g. the groups route).
 */

export type TagLite = { id: string; name: string; color: string | null };

/**
 * Name prefix for per-user SYSTEM scope tags (migration 142). Each group_user
 * scoped by direct dealer selection owns exactly one hidden tag named
 * "__scope:{user_id}" with tags.system=true, applied to the picked dealers —
 * the group ∩ user_tags engine resolves it like any other tag. System tags
 * never appear in tag pickers/filters/chips; /api/tags POST refuses the
 * prefix so operators can't collide with it.
 */
export const USER_SCOPE_TAG_PREFIX = "__scope:";

type Admin = ReturnType<typeof createAdminSupabaseClient>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Established badge-palette keys a tag's `color` may hold (no new colors). */
export const TAG_PALETTE_KEYS = ["blue", "green", "amber", "purple", "pink", "teal"] as const;

/**
 * Deterministic palette key for a tag name, so a tag created without an explicit
 * color always renders the same on-brand chip. Stable hash of lower(name).
 */
export function paletteKeyForName(name: string): string {
  let h = 0;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return TAG_PALETTE_KEYS[Math.abs(h) % TAG_PALETTE_KEYS.length];
}

/** Resolve a `?tag=` value (UUID or case-insensitive name) to a tag id, or null. */
export async function resolveTagId(admin: Admin, tagParam: string): Promise<string | null> {
  const v = tagParam.trim();
  if (!v) return null;
  const db = admin as any;
  if (UUID_RE.test(v)) {
    const { data } = await db.from("tags").select("id").eq("id", v).maybeSingle();
    return data?.id ?? null;
  }
  // ilike with no wildcards = case-insensitive exact match.
  const { data } = await db.from("tags").select("id").ilike("name", v).maybeSingle();
  return data?.id ?? null;
}

type TagJoinRow = { dealer_id?: string; group_id?: string; tags: TagLite | null };

function buildTagMap(rows: TagJoinRow[], key: "dealer_id" | "group_id"): Record<string, TagLite[]> {
  const out: Record<string, TagLite[]> = {};
  for (const row of rows) {
    const id = row[key];
    const t = row.tags;
    if (!id || !t) continue;
    (out[id] ??= []).push({ id: t.id, name: t.name, color: t.color ?? null });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Map of dealer UUID → its tags, for a page of dealers. Excludes hidden
 * per-user system scope tags (migration 142) — those are an implementation
 * detail of group_user direct-dealer scoping, never shown as chips. */
export async function tagsForDealers(admin: Admin, dealerUuids: string[]): Promise<Record<string, TagLite[]>> {
  if (!dealerUuids.length) return {};
  const { data } = await (admin as any)
    .from("dealer_tags")
    .select("dealer_id, tags(id, name, color, system)")
    .in("dealer_id", dealerUuids);
  const rows = ((data ?? []) as Array<TagJoinRow & { tags: (TagLite & { system?: boolean }) | null }>)
    .filter((r) => !r.tags?.system);
  return buildTagMap(rows as TagJoinRow[], "dealer_id");
}

/** The user's private system scope tag ({id, dealerIds} of its in-group
 * assignments), or null when the user has never been directly scoped. */
export async function getUserDirectScope(
  admin: Admin,
  userId: string,
): Promise<{ tagId: string; dealerIds: string[] } | null> {
  const { data: tag } = await (admin as any)
    .from("tags")
    .select("id")
    .eq("name", `${USER_SCOPE_TAG_PREFIX}${userId}`)
    .eq("system", true)
    .maybeSingle();
  if (!tag) return null;
  const { data: dts } = await (admin as any)
    .from("dealer_tags").select("dealer_id").eq("tag_id", tag.id);
  return { tagId: tag.id as string, dealerIds: (dts ?? []).map((r: any) => r.dealer_id as string) };
}

/**
 * Reconcile a group_user's DIRECT dealer scope to exactly `dealerIds`
 * (migration 142). Finds/creates the user's system tag, replaces its
 * dealer_tags rows, and links/unlinks user_tags. Every dealer must belong to
 * `groupId` — the caller's authz decides which group that is (group_admin =
 * their own; super_admin = the target user's). Empty `dealerIds` clears the
 * direct scope (tag row kept for reuse, links removed).
 *
 * Returns an error string (safe to surface) or null on success.
 */
export async function setUserDirectScope(
  admin: Admin,
  opts: { userId: string; groupId: string; dealerIds: string[]; actorId: string | null },
): Promise<string | null> {
  const a = admin as any;
  const wanted = Array.from(new Set(opts.dealerIds.filter((d) => UUID_RE.test(d))));

  // Every picked dealer must be a member of the group.
  if (wanted.length) {
    const { data: members, error: memErr } = await a
      .from("dealers").select("id").eq("group_id", opts.groupId).in("id", wanted);
    if (memErr) return memErr.message;
    const memberIds = new Set((members ?? []).map((r: any) => r.id as string));
    if (wanted.some((d) => !memberIds.has(d))) {
      return "One or more selected dealers are not in this group";
    }
  }

  // Find or create the user's system tag.
  const name = `${USER_SCOPE_TAG_PREFIX}${opts.userId}`;
  let tagId: string;
  const { data: existing } = await a
    .from("tags").select("id").eq("name", name).eq("system", true).maybeSingle();
  if (existing) {
    tagId = existing.id as string;
  } else if (!wanted.length) {
    return null; // clearing a scope that never existed — nothing to do
  } else {
    const { data: created, error: insErr } = await a
      .from("tags")
      .insert({ name, color: null, system: true, created_by: opts.actorId })
      .select("id")
      .single();
    if (insErr) {
      // Lost a create race against the unique(lower(name)) index — re-fetch.
      const { data: raced } = await a
        .from("tags").select("id").eq("name", name).maybeSingle();
      if (!raced) return insErr.message;
      tagId = raced.id as string;
    } else {
      tagId = created.id as string;
    }
  }

  // Reconcile dealer_tags for the system tag to exactly the wanted set.
  const { data: curRows, error: curErr } = await a
    .from("dealer_tags").select("dealer_id").eq("tag_id", tagId);
  if (curErr) return curErr.message;
  const current = new Set<string>((curRows ?? []).map((r: any) => r.dealer_id as string));
  const toAdd = wanted.filter((d) => !current.has(d));
  const toRemove = Array.from(current).filter((d) => !wanted.includes(d));
  if (toRemove.length) {
    const { error: delErr } = await a
      .from("dealer_tags").delete().eq("tag_id", tagId).in("dealer_id", toRemove);
    if (delErr) return delErr.message;
  }
  if (toAdd.length) {
    const { error: addErr } = await a
      .from("dealer_tags")
      .insert(toAdd.map((dealer_id) => ({ dealer_id, tag_id: tagId, created_by: opts.actorId })));
    if (addErr) return addErr.message;
  }

  // Link/unlink user_tags.
  const { data: link } = await a
    .from("user_tags").select("tag_id").eq("user_id", opts.userId).eq("tag_id", tagId).maybeSingle();
  if (wanted.length && !link) {
    const { error: linkErr } = await a
      .from("user_tags")
      .insert({ user_id: opts.userId, tag_id: tagId, created_by: opts.actorId });
    if (linkErr) return linkErr.message;
  } else if (!wanted.length && link) {
    const { error: unlinkErr } = await a
      .from("user_tags").delete().eq("user_id", opts.userId).eq("tag_id", tagId);
    if (unlinkErr) return unlinkErr.message;
  }
  return null;
}

/** Map of group UUID → its tags, for a page of groups. */
export async function tagsForGroups(admin: Admin, groupUuids: string[]): Promise<Record<string, TagLite[]>> {
  if (!groupUuids.length) return {};
  const { data } = await (admin as any)
    .from("group_tags")
    .select("group_id, tags(id, name, color)")
    .in("group_id", groupUuids);
  return buildTagMap((data ?? []) as TagJoinRow[], "group_id");
}

/** Dealer UUIDs assigned a specific tag (for list `?tag=` filtering). */
export async function dealerIdsWithTag(admin: Admin, tagId: string): Promise<string[]> {
  const { data } = await (admin as any).from("dealer_tags").select("dealer_id").eq("tag_id", tagId);
  return Array.from(new Set((data ?? []).map((r: any) => r.dealer_id as string)));
}

/** Dealer UUIDs assigned ANY of the given tags (for group_user scope). */
export async function dealerIdsWithAnyTag(admin: Admin, tagIds: string[]): Promise<string[]> {
  if (!tagIds.length) return [];
  const { data } = await (admin as any).from("dealer_tags").select("dealer_id").in("tag_id", tagIds);
  return Array.from(new Set((data ?? []).map((r: any) => r.dealer_id as string)));
}

/** Group UUIDs assigned a specific tag (for list `?tag=` filtering). */
export async function groupIdsWithTag(admin: Admin, tagId: string): Promise<string[]> {
  const { data } = await (admin as any).from("group_tags").select("group_id").eq("tag_id", tagId);
  return Array.from(new Set((data ?? []).map((r: any) => r.group_id as string)));
}

/** Dealer UUIDs that carry a tag whose name matches `q` (case-insensitive substring). */
export async function dealerIdsMatchingTagName(admin: Admin, q: string): Promise<string[]> {
  const db = admin as any;
  const { data: tags } = await db.from("tags").select("id").ilike("name", `%${q}%`);
  const ids = (tags ?? []).map((t: any) => t.id as string);
  if (!ids.length) return [];
  const { data } = await db.from("dealer_tags").select("dealer_id").in("tag_id", ids);
  return Array.from(new Set((data ?? []).map((r: any) => r.dealer_id as string)));
}

/** Group UUIDs that carry a tag whose name matches `q` (case-insensitive substring). */
export async function groupIdsMatchingTagName(admin: Admin, q: string): Promise<string[]> {
  const db = admin as any;
  const { data: tags } = await db.from("tags").select("id").ilike("name", `%${q}%`);
  const ids = (tags ?? []).map((t: any) => t.id as string);
  if (!ids.length) return [];
  const { data } = await db.from("group_tags").select("group_id").in("tag_id", ids);
  return Array.from(new Set((data ?? []).map((r: any) => r.group_id as string)));
}
