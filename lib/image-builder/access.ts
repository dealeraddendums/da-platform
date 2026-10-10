// Image Builder access (migration 163).
//
// Staff access = super_admin, OR a profile granted `can_use_image_builder`.
// The grant is per-user (not per-role), so it can be handed to one person
// without promoting them. Launch state: super_admin only (no grants).
//
// Dealer self-service is OFF: IMAGE_BUILDER_DEALER_SELF_SERVE is not set, and
// no dealer-scoped surface exists yet. The flag is read here so the future
// ticket has one switch to flip — today it only changes `dealerSelfServe`.

import { NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";

export const DEALER_SELF_SERVE_ENABLED = process.env.IMAGE_BUILDER_DEALER_SELF_SERVE === "1";

// image_designs / image_design_versions aren't in the generated Database type
// (migration 163) — loosely-typed client, matching the codebase convention.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function builderDb(): any {
  return createAdminSupabaseClient();
}

/** True when this user may use the Image Builder as staff. */
export async function hasImageBuilderAccess(claims: Pick<JwtClaims, "sub" | "email" | "role">): Promise<boolean> {
  if (claims.role === "super_admin") return true;
  const db = builderDb();
  const { data: byId } = await db
    .from("profiles").select("can_use_image_builder").eq("id", claims.sub).maybeSingle();
  if (byId) return byId.can_use_image_builder === true;
  if (!claims.email) return false;
  const { data: byEmail } = await db
    .from("profiles").select("can_use_image_builder").eq("email", claims.email).maybeSingle();
  return byEmail?.can_use_image_builder === true;
}

export async function requireImageBuilder(): Promise<
  { claims: JwtClaims; error: null } | { claims: null; error: NextResponse }
> {
  const r = await requireAuth();
  if (r.error) return r;
  if (!(await hasImageBuilderAccess(r.claims))) {
    return { claims: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return r;
}

// ── Scope: platform (staff) or one group (migration 167) ─────────────────────
//
// Every design route takes an optional `?group=<group uuid>`.
//   • no group  → the staff Image Builder, exactly as before (super_admin or a
//                 can_use_image_builder grant); sees platform designs only.
//   • group     → the Group Image Builder: super_admin, or a group_admin /
//                 group_user whose OWN group it is (Allan, 2026-10-07 — regional
//                 managers included). Sees and edits that group's designs only;
//                 no starter templates; exports land in the group's library.
// A design is in scope only when its owner matches — a group can never read
// or write another group's (or a platform) design, and staff can't reach a
// group design through the platform scope.

// • dealer (`?dealer=1`, 2026-10-09) → the dealer's OWN Image Builder. The
//   dealer is NEVER named by the client: it is the session's effective dealer
//   (claims.dealer_id — a dealer_admin's own store, a group_admin / group_user's
//   switched-into store, a super_admin's ghosted store), re-checked through
//   authorizeDealerAction. dealer_user / dealer_restricted can't use it.
//   Designs are owned via image_designs.dealer_uuid (migration 163 reserved
//   it); exports land in image_library scope='dealer' → that dealer's My Images.

export type BuilderScope =
  | { kind: "platform" }
  | { kind: "group"; groupId: string }
  | { kind: "dealer"; dealerUuid: string; dealerTextId: string };

/** Roles that may use a DEALER's Image Builder (on their effective dealer). */
export const DEALER_BUILDER_ROLES = new Set(["dealer_admin", "group_admin", "group_user", "super_admin"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that may use the GROUP Image Builder for their own group. */
export const GROUP_BUILDER_ROLES = new Set(["group_admin", "group_user"]);

export async function requireBuilderScope(req: Request): Promise<
  { claims: JwtClaims; scope: BuilderScope; error: null } | { claims: null; scope: null; error: NextResponse }
> {
  const params = new URL(req.url).searchParams;
  if (params.get("dealer") === "1") return requireDealerBuilderScope();
  const group = params.get("group");
  if (!group) {
    const r = await requireImageBuilder();
    if (r.error) return { claims: null, scope: null, error: r.error };
    return { claims: r.claims, scope: { kind: "platform" }, error: null };
  }
  const forbidden = { claims: null, scope: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  if (!UUID_RE.test(group)) return forbidden;
  const r = await requireAuth();
  if (r.error) return { claims: null, scope: null, error: r.error };
  const ok = r.claims.role === "super_admin"
    || (GROUP_BUILDER_ROLES.has(r.claims.role) && r.claims.group_id === group);
  if (!ok) return forbidden;
  return { claims: r.claims, scope: { kind: "group", groupId: group }, error: null };
}

export async function requireDealerBuilderScope(): Promise<
  { claims: JwtClaims; scope: BuilderScope; error: null } | { claims: null; scope: null; error: NextResponse }
> {
  const r = await requireAuth();
  if (r.error) return { claims: null, scope: null, error: r.error };
  const c = r.claims;
  const dealerTextId = c.dealer_id;
  if (!DEALER_BUILDER_ROLES.has(c.role) || !dealerTextId) {
    return { claims: null, scope: null, error: NextResponse.json({ error: "Switch into a dealership to use its Image Builder." }, { status: 403 }) };
  }
  const authz = await authorizeDealerAction(c, dealerTextId);
  if (!authz.ok) return { claims: null, scope: null, error: authz.response };
  const { data: d } = await builderDb().from("dealers").select("id").eq("dealer_id", dealerTextId).maybeSingle();
  if (!d?.id) return { claims: null, scope: null, error: NextResponse.json({ error: "Dealer not found" }, { status: 404 }) };
  return { claims: c, scope: { kind: "dealer", dealerUuid: d.id as string, dealerTextId }, error: null };
}

/** The owner columns a NEW design in this scope gets. */
export function ownerColumns(scope: BuilderScope): { group_id: string | null; dealer_uuid: string | null } {
  return {
    group_id: scope.kind === "group" ? scope.groupId : null,
    dealer_uuid: scope.kind === "dealer" ? scope.dealerUuid : null,
  };
}

/** Restrict an image_designs query to the scope's own rows. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scopeDesignQuery(q: any, scope: BuilderScope): any {
  if (scope.kind === "group") return q.eq("group_id", scope.groupId).eq("is_template", false);
  if (scope.kind === "dealer") return q.eq("dealer_uuid", scope.dealerUuid).eq("is_template", false);
  return q.is("group_id", null).is("dealer_uuid", null);
}

/** Is this design row inside the caller's scope? (Needs group_id, dealer_uuid + is_template selected.)
 *  Platform = owned by neither a group nor a dealer — a dealer's design must
 *  never surface in the staff tool. */
export function designInScope(d: { group_id: string | null; dealer_uuid?: string | null; is_template?: boolean | null }, scope: BuilderScope): boolean {
  const dealer = d.dealer_uuid ?? null;
  if (scope.kind === "platform") return d.group_id === null && dealer === null;
  if (scope.kind === "dealer") return dealer === scope.dealerUuid && d.group_id === null && !d.is_template;
  return d.group_id === scope.groupId && dealer === null && !d.is_template;
}

/**
 * A replaces_image_id must point at an image the scope may reference: any
 * library image for staff (as before), only the group's / dealer's OWN images otherwise.
 */
export async function replacesImageAllowed(imageId: string | null, scope: BuilderScope): Promise<boolean> {
  if (imageId === null || scope.kind === "platform") return true;
  const { data } = await builderDb().from("image_library").select("scope, group_id, dealer_id").eq("id", imageId).maybeSingle();
  if (scope.kind === "dealer") return !!data && data.scope === "dealer" && data.dealer_id === scope.dealerTextId;
  return !!data && data.scope === "group" && data.group_id === scope.groupId;
}
