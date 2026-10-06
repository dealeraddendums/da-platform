// Self-service dealer exports (Phase 2). Server-only.
// Spec: exports-self-service-spec.md (suite root).
//
// A dealer export is an ordinary feed_companies row with owner_scope='dealer'
// and owner_id = dealers.id, plus exactly one feed_company_dealers row for that
// dealer. Generation, push, the hourly/daily cron and /admin/feeds oversight
// all reuse the existing feed machinery unchanged.

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveDealerForRequest } from "@/lib/dealer-authz";
import {
  RAW_FIELDS, COMPUTED_FIELDS, LIST_FIELD_DEFAULT_SEPARATOR, LIST_SEPARATORS, resolveFeedDealers,
  type ColumnMapping, type FeedCompanyRow, type ListSeparator,
} from "@/lib/feed-export";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Admin = any;

// ── Access ───────────────────────────────────────────────────────────────────

export interface ExportContext {
  admin: Admin;
  role: string;
  userId: string;
  isSuperAdmin: boolean;
  dealer: { id: string; dealer_id: string; name: string; inventory_dealer_id: string | null; group_id: string | null };
}

/**
 * Every exports route starts here. Same rules as the other My Profile
 * integration routes: dealer roles are pinned to their OWN dealer (any
 * ?dealer_id is ignored); super_admin and group operators act on the dealer
 * they've switched into. dealer_user / dealer_restricted can't manage exports.
 */
export async function exportContext(req: NextRequest): Promise<{ ctx: ExportContext } | { response: NextResponse }> {
  const { claims, error } = await requireAuth();
  if (error) return { response: error };
  if (claims.role === "dealer_user" || claims.role === "dealer_restricted") {
    return { response: NextResponse.json({ error: "Only a dealer admin can manage exports." }, { status: 403 }) };
  }
  const resolved = await resolveDealerForRequest(claims, req.nextUrl.searchParams.get("dealer_id"));
  if (!resolved.ok) return { response: resolved.response };
  const admin: Admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, dealer_id, name, inventory_dealer_id, group_id")
    .eq("dealer_id", resolved.dealerId)
    .maybeSingle();
  if (!dealer) return { response: NextResponse.json({ error: "Dealer not found" }, { status: 404 }) };
  return {
    ctx: {
      admin,
      role: claims.role,
      userId: claims.sub,
      isSuperAdmin: claims.role === "super_admin",
      dealer,
    },
  };
}

/** Load an export the context's dealer OWNS — anything else is a 404 (never
 *  reveal another dealer's export exists). */
export async function loadOwnedExport(ctx: ExportContext, id: string): Promise<FeedCompanyRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await ctx.admin
    .from("feed_companies")
    .select("*")
    .eq("id", id)
    .eq("owner_scope", "dealer")
    .eq("owner_id", ctx.dealer.id)
    .maybeSingle();
  return (data as FeedCompanyRow | null) ?? null;
}

// ── Coverage / precedence ────────────────────────────────────────────────────

export interface CoveringExport {
  id: string;
  name: string;
  owner_scope: "platform" | "group";
  managed_by: string;
  push_schedule: string;
  last_push_at: string | null;
}

/**
 * Exports run by someone ELSE that already include this dealer, in precedence
 * order: platform (SuperAdmin) feeds, then the dealer's group's exports. While
 * any exist the dealer can't create or edit its own (two feeds to the same
 * provider would conflict), and the cron pauses the dealer's own exports.
 *
 * Group coverage = an export owned by the dealer's CURRENT group that either
 * covers all members (covers_all_members, so future members too) or has the
 * dealer attached. An attach row left behind on an old group's export doesn't
 * count once the dealer has moved groups.
 */
export async function exportCoverage(admin: Admin, dealerUuid: string): Promise<CoveringExport[]> {
  type F = { id: string; name: string; owner_scope: string | null; owner_id: string | null; push_schedule: string; last_push_at: string | null; covers_all_members?: boolean };
  const [{ data: attached }, { data: dealer }] = await Promise.all([
    admin.from("feed_company_dealers")
      .select("feed_companies(id, name, owner_scope, owner_id, push_schedule, last_push_at)")
      .eq("dealer_uuid", dealerUuid),
    admin.from("dealers").select("group_id, groups(name)").eq("id", dealerUuid).maybeSingle(),
  ]);
  const groupId: string | null = dealer?.group_id ?? null;
  const groupName: string = (dealer?.groups as { name?: string } | null)?.name ?? "your group";

  const platform: CoveringExport[] = [];
  const group = new Map<string, CoveringExport>();
  const asGroup = (f: F): CoveringExport => ({ id: f.id, name: f.name, owner_scope: "group", managed_by: groupName, push_schedule: f.push_schedule, last_push_at: f.last_push_at });
  for (const row of (attached ?? []) as Array<{ feed_companies: F | null }>) {
    const f = row.feed_companies;
    if (!f) continue;
    const scope = f.owner_scope ?? "platform";
    if (scope === "platform") {
      platform.push({ id: f.id, name: f.name, owner_scope: "platform", managed_by: "DealerAddendums", push_schedule: f.push_schedule, last_push_at: f.last_push_at });
    } else if (scope === "group" && groupId && f.owner_id === groupId) {
      group.set(f.id, asGroup(f));
    }
  }
  if (groupId) {
    const { data: allMember } = await admin
      .from("feed_companies")
      .select("id, name, owner_scope, owner_id, push_schedule, last_push_at, covers_all_members")
      .eq("owner_scope", "group").eq("owner_id", groupId).eq("covers_all_members", true);
    for (const f of (allMember ?? []) as F[]) group.set(f.id, asGroup(f));
  }
  return [...platform, ...Array.from(group.values())];
}

// ── Standard mapping ─────────────────────────────────────────────────────────

/** "Same as we do now": the column set of the production Homenet feed — the
 *  only export actually running on 5.0 — so a dealer starting from the
 *  standard gets exactly what the platform already ships. */
export const STANDARD_MAPPING: ColumnMapping[] = [
  { recipientColumn: "DEALER_ID", daField: "DEALER_ID" },
  { recipientColumn: "VIN_NUMBER", daField: "VIN_NUMBER" },
  { recipientColumn: "STOCK_NUMBER", daField: "STOCK_NUMBER" },
  { recipientColumn: "MiscPrice1", daField: "DEALER_DISCOUNTS_NUM" },
  { recipientColumn: "Comment1", daField: "DEALER_DISCOUNTS_TEXT" },
  { recipientColumn: "MiscPrice2", daField: "OP_PRICE_WO_DISCOUNT_MARKUP" },
  { recipientColumn: "Comment2", daField: "OPTIONS_WO_DISCOUNT_MARKUP" },
  { recipientColumn: "MiscPrice3", daField: "ADDED_MARKUP" },
  { recipientColumn: "Comment3", daField: "ADDED_MARKUP_TEXT" },
  { recipientColumn: "MiscPrice4", daField: "GRAND_TOTAL" },
];

/** Field catalog for the column editor. Custom-rule refs are a SuperAdmin
 *  feature and aren't offered to dealers. */
export const DEALER_EXPORT_FIELDS = [...RAW_FIELDS, ...COMPUTED_FIELDS];
const FIELD_SET = new Set(DEALER_EXPORT_FIELDS);
export const LIST_FIELDS = Object.keys(LIST_FIELD_DEFAULT_SEPARATOR);

// ── Validation ───────────────────────────────────────────────────────────────

export interface ExportInput {
  name: string;
  protocol: "ftp" | "sftp";
  ftp_url: string;
  ftp_port: number;
  ftp_path: string | null;
  ftp_username: string;
  /** undefined = keep the stored password (edit) */
  ftp_password?: string;
  filename: string;
  include_vehicles: "printed" | "all";
  push_schedule: "manual" | "hourly" | "daily";
  feed_dealer_id: string;
  column_mappings: ColumnMapping[];
  export_exclusions: string[];
  export_exclusion_match: "exact" | "contains";
}

const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? Array.from(new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))).slice(0, 200) : [];

/** Validate a create/update body. `requirePassword` on create. */
export function parseExportInput(body: Record<string, unknown>, requirePassword: boolean, mode: "dealer" | "group" = "dealer"): { input: ExportInput } | { error: string } {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
  const name = s("name");
  if (!name || name.length > 80) return { error: "Give the export a name (up to 80 characters)." };
  const protocol = s("protocol") === "sftp" ? "sftp" : s("protocol") === "ftp" ? "ftp" : null;
  if (!protocol) return { error: "Protocol must be FTP or SFTP." };
  const ftp_url = s("ftp_url");
  if (!ftp_url) return { error: "Enter the FTP host." };
  const port = Number(body.ftp_port ?? (protocol === "sftp" ? 22 : 21));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be a number between 1 and 65535." };
  const ftp_path = s("ftp_path") || null;
  if (ftp_path && (ftp_path.includes("..") || /[\r\n\0]/.test(ftp_path))) return { error: "The folder path isn't valid." };
  const ftp_username = s("ftp_username");
  if (!ftp_username) return { error: "Enter the FTP username." };
  let ftp_password: string | undefined;
  if (typeof body.ftp_password === "string" && body.ftp_password !== "") ftp_password = body.ftp_password;
  if (requirePassword && !ftp_password) return { error: "Enter the FTP password." };
  const filename = s("filename").replace(/\.csv$/i, "");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(filename)) return { error: "File name may only use letters, numbers, dots, dashes and underscores." };
  const include_vehicles = s("include_vehicles") === "all" ? "all" : "printed";
  const sched = s("push_schedule");
  const push_schedule = sched === "hourly" || sched === "daily" ? sched : "manual";
  const feed_dealer_id = s("feed_dealer_id");
  if (mode === "dealer" && (!feed_dealer_id || feed_dealer_id.length > 100)) return { error: "Enter the dealer ID your provider uses for you." };

  if (!Array.isArray(body.column_mappings) || body.column_mappings.length === 0) return { error: "Add at least one column." };
  if (body.column_mappings.length > 100) return { error: "Too many columns (100 max)." };
  const column_mappings: ColumnMapping[] = [];
  for (const raw of body.column_mappings as Array<Record<string, unknown>>) {
    const recipientColumn = typeof raw?.recipientColumn === "string" ? raw.recipientColumn.trim() : "";
    const daField = typeof raw?.daField === "string" ? raw.daField.trim() : "";
    if (!recipientColumn || recipientColumn.length > 100) return { error: "Every column needs a name (up to 100 characters)." };
    if (!FIELD_SET.has(daField)) return { error: `Unknown data field for "${recipientColumn}".` };
    const m: ColumnMapping = { recipientColumn, daField };
    if (raw.separator !== undefined && raw.separator !== null && raw.separator !== "") {
      if (typeof raw.separator !== "string" || !(raw.separator in LIST_SEPARATORS)) return { error: `Invalid separator for "${recipientColumn}".` };
      m.separator = raw.separator as ListSeparator;
    }
    if (raw.exclusions !== undefined && raw.exclusions !== null) {
      if (!Array.isArray(raw.exclusions)) return { error: `Exclusions for "${recipientColumn}" must be a list.` };
      m.exclusions = cleanList(raw.exclusions);
      if (raw.exclusionMatch === "exact" || raw.exclusionMatch === "contains") m.exclusionMatch = raw.exclusionMatch;
    }
    column_mappings.push(m);
  }
  const match = s("export_exclusion_match") === "contains" ? "contains" : "exact";
  return {
    input: {
      name, protocol, ftp_url, ftp_port: port, ftp_path, ftp_username, ftp_password, filename,
      include_vehicles, push_schedule, feed_dealer_id, column_mappings,
      export_exclusions: cleanList(body.export_exclusions), export_exclusion_match: match,
    },
  };
}

// ── Serialization (never returns the password) ───────────────────────────────

export function serializeExport(f: FeedCompanyRow & Record<string, unknown>, feedDealerId: string | null) {
  return {
    id: f.id,
    name: f.name,
    protocol: f.protocol,
    ftp_url: f.ftp_url,
    ftp_port: f.ftp_port,
    ftp_path: f.ftp_path ?? null,
    ftp_username: f.ftp_username,
    has_password: Boolean(f.ftp_password),
    filename: f.filename,
    include_vehicles: f.include_vehicles,
    push_schedule: f.push_schedule,
    feed_dealer_id: feedDealerId,
    column_mappings: f.column_mappings ?? [],
    export_exclusions: f.export_exclusions ?? [],
    export_exclusion_match: f.export_exclusion_match ?? "exact",
    last_push_at: f.last_push_at,
    last_push_status: f.last_push_status,
    covers_all_members: Boolean(f.covers_all_members),
  };
}

/**
 * Group-export target from a request body: covers_all_members, or a list of
 * specific members. `dealers` carries Feed Dealer IDs ({dealer_uuid,
 * feed_dealer_id}); for an all-members export they are optional overrides.
 * Every dealer must be a CURRENT member, and a specific target may not be a
 * dealer a platform feed already covers (platform > group).
 */
export function parseGroupTarget(body: Record<string, unknown>, members: GroupMember[]):
  { coversAll: boolean; dealers: Array<{ dealer_uuid: string; feed_dealer_id: string }> } | { error: string; status: number } {
  const coversAll = body.covers_all_members === true;
  const byId = new Map(members.map((m) => [m.id, m]));
  const raw = Array.isArray(body.dealers) ? (body.dealers as Array<Record<string, unknown>>) : [];
  const dealers: Array<{ dealer_uuid: string; feed_dealer_id: string }> = [];
  const seen = new Set<string>();
  for (const d of raw) {
    const id = typeof d?.dealer_uuid === "string" ? d.dealer_uuid : "";
    const m = byId.get(id);
    if (!m) return { error: "One of the selected dealerships isn't in this group.", status: 400 };
    if (seen.has(id)) continue;
    seen.add(id);
    const fid = typeof d.feed_dealer_id === "string" && d.feed_dealer_id.trim() ? d.feed_dealer_id.trim() : m.default_feed_dealer_id;
    if (fid.length > 100) return { error: `Dealer ID for ${m.name} is too long.`, status: 400 };
    if (!coversAll && m.platform_covered_by) {
      return { error: `${m.name} is already exported by DealerAddendums ("${m.platform_covered_by}"), which takes precedence over a group export.`, status: 409 };
    }
    dealers.push({ dealer_uuid: id, feed_dealer_id: fid });
  }
  if (!coversAll && dealers.length === 0) return { error: "Choose at least one dealership, or All dealerships.", status: 400 };
  return { coversAll, dealers };
}

// ── Group exports (Phase 3) ──────────────────────────────────────────────────

export interface GroupExportContext {
  admin: Admin;
  role: string;
  userId: string;
  isSuperAdmin: boolean;
  group: { id: string; name: string };
}

/**
 * Group exports are managed by that group's group_admin, or super_admin. A
 * group-ghosting super_admin is confined to the ghosted group. Anyone else —
 * including a group_admin of another group — gets a 404 (never reveal another
 * group's exports exist); dealer roles and group_user get a 403.
 */
export async function groupExportContext(groupId: string): Promise<{ ctx: GroupExportContext } | { response: NextResponse }> {
  const { claims, error } = await requireAuth();
  if (error) return { response: error };
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return { response: NextResponse.json({ error: "Only a group admin can manage group exports." }, { status: 403 }) };
  }
  if (!/^[0-9a-f-]{36}$/i.test(groupId)) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (claims.role === "group_admin" && claims.group_id !== groupId) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const ghostGroup = (claims as { ghost_group_uuid?: string | null }).ghost_group_uuid ?? null;
  if (claims.role === "super_admin" && ghostGroup && ghostGroup !== groupId) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const admin: Admin = createAdminSupabaseClient();
  const { data: group } = await admin.from("groups").select("id, name").eq("id", groupId).maybeSingle();
  if (!group) return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return { ctx: { admin, role: claims.role, userId: claims.sub, isSuperAdmin: claims.role === "super_admin", group } };
}

export async function loadOwnedGroupExport(ctx: GroupExportContext, id: string): Promise<FeedCompanyRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await ctx.admin.from("feed_companies").select("*")
    .eq("id", id).eq("owner_scope", "group").eq("owner_id", ctx.group.id).maybeSingle();
  return (data as FeedCompanyRow | null) ?? null;
}

export interface GroupMember {
  id: string; dealer_id: string; name: string; active: boolean;
  default_feed_dealer_id: string;
  /** A platform feed already covers this dealer — group exports leave it out. */
  platform_covered_by: string | null;
}

export async function groupMembers(admin: Admin, groupId: string): Promise<GroupMember[]> {
  const { data: members } = await admin.from("dealers")
    .select("id, dealer_id, name, active, inventory_dealer_id").eq("group_id", groupId).order("name");
  const ids = (members ?? []).map((m: { id: string }) => m.id);
  const platformBy = new Map<string, string>();
  if (ids.length) {
    const { data: rows } = await admin.from("feed_company_dealers")
      .select("dealer_uuid, feed_companies!inner(name, owner_scope)")
      .in("dealer_uuid", ids).eq("feed_companies.owner_scope", "platform");
    (rows ?? []).forEach((r: { dealer_uuid: string; feed_companies: { name: string } }) => platformBy.set(r.dealer_uuid, r.feed_companies.name));
  }
  return (members ?? []).map((m: { id: string; dealer_id: string; name: string; active: boolean | null; inventory_dealer_id: string | null }) => ({
    id: m.id, dealer_id: m.dealer_id, name: m.name, active: m.active !== false,
    default_feed_dealer_id: m.inventory_dealer_id || m.dealer_id,
    platform_covered_by: platformBy.get(m.id) ?? null,
  }));
}

/** Who a group export currently sends for, for the UI. */
export async function groupExportPlan(admin: Admin, feed: FeedCompanyRow) {
  const plan = await resolveFeedDealers(admin, feed);
  return {
    dealers: plan.rows.map((r) => ({ dealer_uuid: r.dealer_uuid, name: r.dealers?.name ?? "", feed_dealer_id: r.feed_dealer_id })),
    excluded: plan.excluded,
  };
}
