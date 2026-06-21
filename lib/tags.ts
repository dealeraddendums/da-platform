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

/** Map of dealer UUID → its tags, for a page of dealers. */
export async function tagsForDealers(admin: Admin, dealerUuids: string[]): Promise<Record<string, TagLite[]>> {
  if (!dealerUuids.length) return {};
  const { data } = await (admin as any)
    .from("dealer_tags")
    .select("dealer_id, tags(id, name, color)")
    .in("dealer_id", dealerUuids);
  return buildTagMap((data ?? []) as TagJoinRow[], "dealer_id");
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
