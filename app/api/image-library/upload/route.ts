import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  ALLOWED_BUCKETS, ALLOWED_TYPES, REGION, s3Client, cleanDisplayName,
  resolveUploadScope, scopedKey,
} from "@/lib/image-library";

// Scope-aware image upload for dealer_admin / group_admin (and super_admin).
// The scope is derived from getJwtClaims — a caller can never write a
// scope/owner they don't belong to. super_admin platform uploads also still
// work via /api/admin/image-library/upload.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const target = resolveUploadScope(claims);
  if (!target) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let formData: FormData;
  try { formData = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string | null)?.trim();

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!bucket || !ALLOWED_BUCKETS[bucket]) {
    return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "File type not allowed" }, { status: 422 });
  }
  const maxBytes = ALLOWED_BUCKETS[bucket].maxMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json({ error: `File must be under ${ALLOWED_BUCKETS[bucket].maxMB} MB` }, { status: 422 });
  }

  const key = scopedKey(
    target.scope,
    { group_id: "group_id" in target ? target.group_id : undefined, dealer_id: "dealer_id" in target ? target.dealer_id : undefined },
    file
  );

  const buffer = Buffer.from(await file.arrayBuffer());
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: file.type }));

  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  const displayName = cleanDisplayName(file.name.replace(/[^a-zA-Z0-9._-]/g, "_"));

  const admin = createAdminSupabaseClient();
  const { data: libRow, error: dbErr } = await admin
    .from("image_library")
    .upsert({
      bucket,
      s3_key: key,
      url,
      display_name: displayName,
      file_size: file.size,
      uploaded_by: claims.sub,
      scope: target.scope,
      group_id: "group_id" in target ? target.group_id : null,
      dealer_id: "dealer_id" in target ? target.dealer_id : null,
    }, { onConflict: "bucket,s3_key" })
    .select("id, display_name")
    .single();

  if (dbErr) {
    return NextResponse.json({ error: dbErr.message }, { status: 500 });
  }

  return NextResponse.json(
    { url, key, id: libRow?.id ?? null, display_name: libRow?.display_name ?? displayName, scope: target.scope },
    { status: 201 }
  );
}
