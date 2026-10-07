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

export type BuilderScope = { kind: "platform" } | { kind: "group"; groupId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that may use the GROUP Image Builder for their own group. */
export const GROUP_BUILDER_ROLES = new Set(["group_admin", "group_user"]);

export async function requireBuilderScope(req: Request): Promise<
  { claims: JwtClaims; scope: BuilderScope; error: null } | { claims: null; scope: null; error: NextResponse }
> {
  const group = new URL(req.url).searchParams.get("group");
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

/** Is this design row inside the caller's scope? (Needs group_id + is_template selected.) */
export function designInScope(d: { group_id: string | null; is_template?: boolean | null }, scope: BuilderScope): boolean {
  if (scope.kind === "platform") return d.group_id === null;
  return d.group_id === scope.groupId && !d.is_template;
}

/**
 * A replaces_image_id must point at an image the scope may reference: any
 * library image for staff (as before), only the group's OWN images for a group.
 */
export async function replacesImageAllowed(imageId: string | null, scope: BuilderScope): Promise<boolean> {
  if (imageId === null || scope.kind === "platform") return true;
  const { data } = await builderDb().from("image_library").select("scope, group_id").eq("id", imageId).maybeSingle();
  return !!data && data.scope === "group" && data.group_id === scope.groupId;
}
