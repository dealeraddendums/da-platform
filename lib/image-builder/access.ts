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
