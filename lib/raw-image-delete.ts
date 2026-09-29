// Ownership + in-use rules for deleting images that live as RAW S3 OBJECTS
// (logos, custom-size backgrounds, product images) rather than as image_library
// rows. See app/api/upload-image/route.ts for the endpoint.
//
// Why this is its own module, and why the rules look asymmetric:
//
// image_library (migration 090) carries a real owner — scope + group_id +
// dealer_id — so its DELETE can authorize off the row. The buckets below have
// NO such record. Ownership, where it exists at all, is encoded only in the S3
// key prefix that the CLIENT happened to send at upload time. So every rule
// here is derived server-side from claims and matched against the key; a
// client-supplied prefix is never trusted.
//
// Measured on prod 2026-09-29 before writing this:
//   new-dealer-logos         272 objects, 188 distinct `{dealer_id}/` prefixes,
//                            10 legacy root-level objects owned by nobody.
//   addendum-product-images  127 objects, 126 of them at the bucket ROOT with
//                            no prefix whatsoever.
// Hence: logos are safely dealer-deletable; product images are NOT, at any
// dealer/group role, because nothing in the key says who uploaded it and the
// same URL may be embedded in many dealers' option HTML. That bucket is
// super_admin-only until it grows a real ownership model.

import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const REGION = process.env.AWS_REGION || "us-east-1";

/** Buckets reachable through /api/upload-image. */
export const RAW_IMAGE_BUCKETS = new Set([
  "new-addendum-backgrounds",
  "new-infosheet-backgrounds",
  "new-dealer-logos",
  "addendum-product-images",
  "new-infobox-images",
]);

/** Buckets whose objects carry no owner at all — super_admin deletes only. */
export const UNOWNED_BUCKETS = new Set(["addendum-product-images"]);

/** Buckets ALSO used by image_library, whose scoped keys are `dealer/…` and
 *  `group/…`. Those objects have a DB row; deleting them here would orphan it,
 *  so this route refuses them and defers to DELETE /api/image-library. */
export const IMAGE_LIBRARY_BUCKETS = new Set([
  "new-infobox-images",
  "new-addendum-backgrounds",
  "new-infosheet-backgrounds",
]);

export interface DeleteContext {
  isSuper: boolean;
  /** Key prefixes this caller owns. Empty for a caller who owns nothing. */
  prefixes: string[];
}

/**
 * What may this caller delete? Derived only from resolved claims.
 *   super_admin (not ghosted) → everything
 *   dealer-context roles      → `{dealer_id}/` and `custom/{dealer_id}/`
 *   group_admin (not acting)  → `group/{group_id}/`
 */
export function resolveDeleteContext(claims: JwtClaims): DeleteContext {
  if (claims.role === "super_admin" && !claims.is_ghost) return { isSuper: true, prefixes: [] };

  // A ghosted super_admin acts as the dealer, same as the dealer would.
  const dealerId = claims.dealer_id ?? null;
  const actingAsDealer =
    claims.role === "dealer_admin" ||
    (claims.role === "super_admin" && claims.is_ghost) ||
    ((claims.role === "group_admin" || claims.role === "group_user") && !!claims.active_dealer_id);

  if (actingAsDealer && dealerId) {
    return { isSuper: false, prefixes: [`${dealerId}/`, `custom/${dealerId}/`] };
  }
  if (claims.role === "group_admin" && claims.group_id) {
    return { isSuper: false, prefixes: [`group/${claims.group_id}/`] };
  }
  return { isSuper: false, prefixes: [] };
}

/** May this caller delete this exact object? */
export function isDeletableKey(bucket: string, key: string, ctx: DeleteContext): boolean {
  if (!RAW_IMAGE_BUCKETS.has(bucket)) return false;

  // image_library owns `dealer/…` and `group/…` keys in its buckets — it has a
  // row to clean up, so that route must do the delete, not this one.
  if (IMAGE_LIBRARY_BUCKETS.has(bucket) && (key.startsWith("dealer/") || key.startsWith("group/"))) {
    return false;
  }

  if (ctx.isSuper) return true;

  // No owner in the key → nobody but super_admin can claim it. This covers
  // every root-level object, which is 126 of the 127 product images and the
  // 10 legacy logos.
  if (UNOWNED_BUCKETS.has(bucket)) return false;
  if (!key.includes("/")) return false;

  return ctx.prefixes.some(p => key.startsWith(p));
}

/**
 * Where is this image still referenced? Returns human-readable strings for the
 * confirm dialog. Best-effort and deliberately bounded — it answers "is this in
 * use", not "prove it is unused", and the caller can still force the delete.
 *
 * Consumers all degrade gracefully on a dead URL: the Logo widget already
 * renders nothing without a logo, a missing background falls back to the
 * default, and a broken <img> in option HTML shows its alt text.
 */
export async function findImageUsage(url: string): Promise<string[]> {
  const admin = createAdminSupabaseClient();
  const used: string[] = [];
  // The stored value is sometimes the bare S3 key rather than the full URL
  // (dealers.logo_url accepts both — see the S3_LOGO prefixing in pdf/generate).
  const tail = url.split("/").slice(-2).join("/");
  const like = `%${tail}%`;

  const [logos, sizes, prodLib, grpOpts, vehOpts] = await Promise.all([
    admin.from("dealers").select("name").ilike("logo_url", like).limit(5),
    admin.from("dealer_custom_sizes").select("name").ilike("background_url", like).limit(5),
    admin.from("addendum_library").select("option_name").ilike("description", like).limit(5),
    admin.from("group_options").select("option_name").ilike("description", like).limit(5),
    admin.from("vehicle_options").select("option_name").ilike("description", like).limit(5),
  ]);

  for (const d of logos.data ?? []) used.push(`the current logo for ${(d as { name: string }).name}`);
  for (const s of sizes.data ?? []) used.push(`custom paper size "${(s as { name: string }).name}"`);
  const productNames = new Set<string>();
  for (const r of [...(prodLib.data ?? []), ...(grpOpts.data ?? []), ...(vehOpts.data ?? [])]) {
    productNames.add((r as { option_name: string }).option_name);
  }
  productNames.forEach(n => used.push(`product "${n}"`));

  // Templates store the URL inside template_json (jsonb), which PostgREST
  // can't substring-match, so scan the rows in JS. Bounded by .range() — the
  // fleet has ~200 addendum templates, so one page is the whole set.
  for (const table of ["templates", "group_templates"] as const) {
    const { data } = await admin.from(table).select("name, template_json").range(0, 999);
    for (const row of (data ?? []) as { name: string; template_json: unknown }[]) {
      if (JSON.stringify(row.template_json ?? "").includes(tail)) {
        used.push(`template "${row.name}"`);
      }
    }
  }
  return used;
}
