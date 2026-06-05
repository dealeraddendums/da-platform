import { randomUUID } from "crypto";
import { S3Client } from "@aws-sdk/client-s3";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Shared config + scope resolution for the Builder image library
// (Platform / Group / Dealer). See docs/builder-scoped-images.md.
//
// Storage: the `bucket` value is the image CATEGORY and the real S3 bucket.
// Platform images sit at the bucket root (`{ts}_name.png`). Group/dealer images
// use scope-prefixed keys (`group/{group_id}/…`, `dealer/{dealer_id}/…`) so a
// raw bucket listing (which only ever enumerates root keys) can't surface them —
// the scoped picker reads them from image_library, filtered by the caller's
// scope. This keeps the existing public-read buckets (no new bucket to provision)
// while preventing cross-dealer leakage.

export const REGION = process.env.AWS_REGION || "us-east-1";

export const ALLOWED_BUCKETS: Record<string, { maxMB: number }> = {
  "new-infobox-images": { maxMB: 5 },
  "new-addendum-backgrounds": { maxMB: 5 },
  "new-infosheet-backgrounds": { maxMB: 10 },
};

export const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];

export type ImageScope = "platform" | "group" | "dealer";

export function s3Client(): S3Client {
  return new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
}

export function cleanDisplayName(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  return base.replace(/^\d{10,}_/, "");
}

function extFor(file: { name: string; type: string }): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp" };
  return map[file.type] ?? "png";
}

/**
 * Decide the scope of an UPLOAD purely from server-resolved claims — never a
 * client-supplied value. Returns null if the caller may not upload.
 *   super_admin            → platform (or the ghosted dealer, if any)
 *   group_admin (acting)   → dealer (their active dealer)
 *   group_admin            → group
 *   dealer_admin           → dealer
 */
export function resolveUploadScope(claims: JwtClaims):
  | { scope: "platform" }
  | { scope: "group"; group_id: string }
  | { scope: "dealer"; dealer_id: string }
  | null {
  if (claims.role === "dealer_admin") {
    return claims.dealer_id ? { scope: "dealer", dealer_id: claims.dealer_id } : null;
  }
  if (claims.role === "group_admin") {
    if (claims.active_dealer_id && claims.dealer_id) return { scope: "dealer", dealer_id: claims.dealer_id };
    return claims.group_id ? { scope: "group", group_id: claims.group_id } : null;
  }
  if (claims.role === "super_admin") {
    if (claims.is_ghost && claims.dealer_id) return { scope: "dealer", dealer_id: claims.dealer_id };
    return { scope: "platform" };
  }
  return null;
}

/** Build the S3 key for an upload of the given scope. */
export function scopedKey(
  scope: ImageScope,
  owner: { group_id?: string; dealer_id?: string },
  file: { name: string; type: string }
): string {
  const ext = extFor(file);
  if (scope === "group") return `group/${owner.group_id}/${randomUUID()}.${ext}`;
  if (scope === "dealer") return `dealer/${owner.dealer_id}/${randomUUID()}.${ext}`;
  // platform: keep the legacy root key shape so the platform listing finds it
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${Date.now()}_${cleanName}`;
}

/**
 * Resolve what a viewer can SEE: their effective dealer (text id) and group
 * (uuid). A dealer's group lives on the dealers row, not the profile, so we
 * resolve it here. A group_admin acting as a dealer also gets that dealer's group.
 */
export async function resolveViewContext(claims: JwtClaims): Promise<{ dealerId: string | null; groupId: string | null }> {
  const dealerId = claims.dealer_id ?? null;
  let groupId = claims.group_id ?? null;
  if (!groupId && dealerId) {
    const admin = createAdminSupabaseClient();
    const { data } = await admin.from("dealers").select("group_id").eq("dealer_id", dealerId).maybeSingle<{ group_id: string | null }>();
    groupId = data?.group_id ?? null;
  }
  return { dealerId, groupId };
}
