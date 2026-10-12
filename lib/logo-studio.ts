import "server-only";
import { randomUUID } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { requireAuth, type JwtClaims } from "@/lib/auth";
import { requireDealerBuilderScope } from "@/lib/image-builder/access";
import { REGION, s3Client } from "@/lib/image-library";
import { createAdminSupabaseClient } from "@/lib/db";

// Logo Studio (DA-LogoForge Phase 3, 2026-10-11): shared scope resolution +
// storage for the two entry points — My Group → Logo Studio, and Print
// Settings → Dealer Logo → "Clean up / vectorize".
//
// Scope is resolved from the SESSION, never trusted from the client:
//  • dealer → the session's effective dealer (requireDealerBuilderScope: a
//    dealer_admin's store, a group_admin / group_user's switched-into store, a
//    super_admin's ghosted store). The client may name the dealer it THINKS it
//    is editing (`expectDealer`) only so a mismatch is refused, never to choose.
//  • group  → super_admin, or a group_admin whose own group it is.

export const LOGO_BUCKET = "new-dealer-logos";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PNG_LONG_EDGE = 1500;

export type LogoScope =
  | { kind: "dealer"; dealerTextId: string; dealerUuid: string }
  | { kind: "group"; groupId: string };

export async function requireLogoScope(params: URLSearchParams, expectDealer?: string | null): Promise<
  { claims: JwtClaims; scope: LogoScope; error: null } | { claims: null; scope: null; error: NextResponse }
> {
  const deny = (msg: string, status = 403) =>
    ({ claims: null, scope: null, error: NextResponse.json({ error: msg }, { status }) }) as const;
  const kind = params.get("scope");
  if (kind === "dealer") {
    const r = await requireDealerBuilderScope();
    if (r.error) return { claims: null, scope: null, error: r.error };
    if (r.scope.kind !== "dealer") return deny("Forbidden");
    if (expectDealer && expectDealer !== r.scope.dealerTextId) {
      return deny("This page is for a different dealership than the one you're signed in as. Switch into that dealership first.", 409);
    }
    return { claims: r.claims, scope: { kind: "dealer", dealerTextId: r.scope.dealerTextId, dealerUuid: r.scope.dealerUuid }, error: null };
  }
  if (kind === "group") {
    const groupId = params.get("group") ?? "";
    if (!UUID_RE.test(groupId)) return deny("Forbidden");
    const r = await requireAuth();
    if (r.error) return { claims: null, scope: null, error: r.error };
    const ok = r.claims.role === "super_admin" || (r.claims.role === "group_admin" && r.claims.group_id === groupId);
    if (!ok) return deny("Forbidden");
    return { claims: r.claims, scope: { kind: "group", groupId }, error: null };
  }
  return deny("scope must be dealer or group", 400);
}

/**
 * Store an already-SANITIZED logo SVG (master) + a PNG rendered from it into the
 * scope's logo library (bucket new-dealer-logos = the logo category, so logos
 * never show up under Backgrounds; scope-prefixed keys per migration 090). One
 * image_library row, pointing at the SVG — what the Logo widget and Logo
 * library use. The PNG sits beside it at the same key with .png.
 */
export async function storeLogo(
  scope: LogoScope,
  svg: string,
  name: string,
  uploadedBy: string,
): Promise<{ id: string; url: string; pngUrl: string; display_name: string }> {
  const svgBytes = Buffer.from(svg, "utf8");
  const meta = await sharp(svgBytes).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  if (!w || !h) throw new Error("SVG has no size");
  const scale = PNG_LONG_EDGE / Math.max(w, h);
  const png = await sharp(svgBytes, { density: Math.min(2400, Math.max(72, Math.round(72 * scale))) })
    .resize(w >= h ? { width: PNG_LONG_EDGE } : { height: PNG_LONG_EDGE })
    .png()
    .toBuffer();

  const base = scope.kind === "group" ? `group/${scope.groupId}/${randomUUID()}` : `dealer/${scope.dealerTextId}/${randomUUID()}`;
  const s3 = s3Client();
  await Promise.all([
    s3.send(new PutObjectCommand({ Bucket: LOGO_BUCKET, Key: `${base}.svg`, Body: svgBytes, ContentType: "image/svg+xml",
      ContentDisposition: "inline", CacheControl: "public, max-age=31536000, immutable" })),
    s3.send(new PutObjectCommand({ Bucket: LOGO_BUCKET, Key: `${base}.png`, Body: png, ContentType: "image/png",
      CacheControl: "public, max-age=31536000, immutable" })),
  ]);
  const url = `https://${LOGO_BUCKET}.s3.${REGION}.amazonaws.com/${base}.svg`;
  const pngUrl = `https://${LOGO_BUCKET}.s3.${REGION}.amazonaws.com/${base}.png`;
  const displayName = (name.trim() || "Logo").replace(/[\u0000-\u001f<>]/g, "").slice(0, 120);
  const { data, error } = await createAdminSupabaseClient()
    .from("image_library")
    .insert({
      bucket: LOGO_BUCKET, s3_key: `${base}.svg`, url, display_name: displayName, file_size: svgBytes.length, uploaded_by: uploadedBy,
      ...(scope.kind === "group" ? { scope: "group", group_id: scope.groupId } : { scope: "dealer", dealer_id: scope.dealerTextId }),
    })
    .select("id, url, display_name")
    .single();
  if (error || !data) throw new Error(error?.message ?? "image_library write failed");
  return { id: data.id as string, url: data.url as string, pngUrl, display_name: data.display_name as string };
}
