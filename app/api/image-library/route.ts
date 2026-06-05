import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { ALLOWED_BUCKETS, REGION, s3Client, cleanDisplayName, resolveViewContext } from "@/lib/image-library";

// Scoped image library for the Builder picker. Returns the images visible to the
// caller — platform (everyone) + their group + their (active) dealer — each
// tagged with its scope. Scope is resolved from getJwtClaims, never the client.

type OutImage = {
  id: string | null;
  key: string;
  bucket: string;
  url: string;
  size: number;
  display_name: string;
  scope: "platform" | "group" | "dealer";
  deletable: boolean;
};

/** GET /api/image-library?bucket=<category> */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const bucket = req.nextUrl.searchParams.get("bucket")?.trim() ?? "";
  if (!ALLOWED_BUCKETS[bucket]) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { dealerId, groupId } = await resolveViewContext(claims);

  const isSuper = claims.role === "super_admin";
  const canManageGroup = claims.role === "group_admin" && !claims.active_dealer_id;
  const canManageDealer =
    claims.role === "dealer_admin" ||
    (claims.role === "group_admin" && !!claims.active_dealer_id) ||
    (isSuper && claims.is_ghost);

  const out: OutImage[] = [];

  // ── Platform images: list the category bucket ROOT (keys without "/"), so
  //    scope-prefixed group/dealer objects are never surfaced here. Auto-populate
  //    platform rows for any S3 object missing one (preserves legacy behavior).
  const s3 = s3Client();
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
  const platformObjs = (listed.Contents ?? [])
    .filter((o) => o.Key && !o.Key.includes("/") && /\.(png|jpg|jpeg|gif|webp)$/i.test(o.Key))
    .map((o) => ({ key: o.Key!, size: o.Size ?? 0, url: `https://${bucket}.s3.${REGION}.amazonaws.com/${o.Key!}` }));

  const { data: platRows } = await admin
    .from("image_library")
    .select("id, s3_key, display_name")
    .eq("bucket", bucket)
    .eq("scope", "platform");
  const platMap = new Map((platRows ?? []).map((r) => [r.s3_key as string, r as { id: string; s3_key: string; display_name: string }]));

  const missing = platformObjs.filter((o) => !platMap.has(o.key));
  if (missing.length > 0) {
    const { data: inserted } = await admin
      .from("image_library")
      .upsert(
        missing.map((o) => ({
          bucket, s3_key: o.key, url: o.url, display_name: cleanDisplayName(o.key), file_size: o.size, scope: "platform" as const,
        })),
        { onConflict: "bucket,s3_key" }
      )
      .select("id, s3_key, display_name");
    for (const r of inserted ?? []) platMap.set(r.s3_key as string, r as { id: string; s3_key: string; display_name: string });
  }

  for (const o of platformObjs) {
    const row = platMap.get(o.key);
    out.push({
      id: row?.id ?? null, key: o.key, bucket, url: o.url, size: o.size,
      display_name: row?.display_name ?? cleanDisplayName(o.key), scope: "platform", deletable: isSuper,
    });
  }

  // ── Group images (caller's group) ────────────────────────────────────────
  if (groupId) {
    const { data: rows } = await admin
      .from("image_library")
      .select("id, s3_key, url, display_name, file_size")
      .eq("bucket", bucket).eq("scope", "group").eq("group_id", groupId)
      .order("display_name");
    for (const r of rows ?? []) {
      out.push({
        id: r.id as string, key: r.s3_key as string, bucket, url: r.url as string, size: (r.file_size as number) ?? 0,
        display_name: r.display_name as string, scope: "group", deletable: isSuper || canManageGroup,
      });
    }
  }

  // ── Dealer images (caller's effective dealer) ────────────────────────────
  if (dealerId) {
    const { data: rows } = await admin
      .from("image_library")
      .select("id, s3_key, url, display_name, file_size")
      .eq("bucket", bucket).eq("scope", "dealer").eq("dealer_id", dealerId)
      .order("display_name");
    for (const r of rows ?? []) {
      out.push({
        id: r.id as string, key: r.s3_key as string, bucket, url: r.url as string, size: (r.file_size as number) ?? 0,
        display_name: r.display_name as string, scope: "dealer", deletable: isSuper || canManageDealer,
      });
    }
  }

  // Group display name for the picker section header.
  let groupName: string | null = null;
  if (groupId) {
    const { data: g } = await admin.from("groups").select("name").eq("id", groupId).maybeSingle<{ name: string }>();
    groupName = g?.name ?? null;
  }

  return NextResponse.json({
    images: out,
    groupName,
    caller: {
      canUploadPlatform: isSuper && !claims.is_ghost,
      canUploadGroup: canManageGroup,
      canUploadDealer: canManageDealer,
    },
  });
}

/** DELETE /api/image-library?id=<uuid> — scope-checked (own scope only). */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: row } = await admin
    .from("image_library")
    .select("id, bucket, s3_key, scope, group_id, dealer_id")
    .eq("id", id)
    .maybeSingle<{ id: string; bucket: string; s3_key: string; scope: string; group_id: string | null; dealer_id: string | null }>();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!(await canMutate(claims, row))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await Promise.all([
    s3Client().send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.s3_key })).catch(() => null),
    admin.from("image_library").delete().eq("id", id),
  ]);
  return NextResponse.json({ ok: true });
}

/** PATCH /api/image-library?id=<uuid>  { display_name } — rename, scope-checked. */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  let body: { display_name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const displayName = body.display_name?.trim();
  if (!displayName) return NextResponse.json({ error: "display_name required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: row } = await admin
    .from("image_library")
    .select("id, scope, group_id, dealer_id")
    .eq("id", id)
    .maybeSingle<{ id: string; scope: string; group_id: string | null; dealer_id: string | null }>();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!(await canMutate(claims, row))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await admin.from("image_library").update({ display_name: displayName }).eq("id", id);
  return NextResponse.json({ ok: true, display_name: displayName });
}

// Can this caller delete/rename this row? Mirrors the upload scope rules.
async function canMutate(
  claims: { role: string; group_id: string | null; dealer_id: string | null; active_dealer_id: string | null },
  row: { scope: string; group_id: string | null; dealer_id: string | null }
): Promise<boolean> {
  if (claims.role === "super_admin") return true;
  if (row.scope === "group") {
    return claims.role === "group_admin" && !!row.group_id && row.group_id === claims.group_id;
  }
  if (row.scope === "dealer") {
    if (claims.role === "dealer_admin") return !!row.dealer_id && row.dealer_id === claims.dealer_id;
    if (claims.role === "group_admin" && claims.active_dealer_id) return !!row.dealer_id && row.dealer_id === claims.dealer_id;
    return false;
  }
  return false; // platform → super_admin only (handled above)
}
