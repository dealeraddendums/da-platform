import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import {
  ALLOWED_BUCKETS, ALLOWED_TYPES, REGION, s3Client, cleanDisplayName, scopedKey,
} from "@/lib/image-library";

type Params = { params: { id: string } };

// Group Admin Image Library — manage the group-scoped images available to every
// dealer in the group. super_admin: any group; group_admin: own group only.
async function authorize(groupId: string) {
  const { claims, error } = await requireAuth();
  if (error) return { claims: null, error };
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return { claims: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (claims.role === "group_admin" && claims.group_id !== groupId) {
    return { claims: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { claims, error: null as null };
}

/** GET /api/groups/[id]/images — list this group's images (all categories). */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorize(params.id);
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data } = await admin
    .from("image_library")
    .select("id, bucket, s3_key, url, display_name, file_size, uploaded_at")
    .eq("scope", "group").eq("group_id", params.id)
    .order("uploaded_at", { ascending: false });

  return NextResponse.json({ images: data ?? [] });
}

/** POST /api/groups/[id]/images — upload a group image. FormData { file, bucket }. */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await authorize(params.id);
  if (error) return error;

  let formData: FormData;
  try { formData = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = formData.get("file") as File | null;
  const bucket = (formData.get("bucket") as string | null)?.trim();

  if (!file) return NextResponse.json({ error: "No file provided" }, { status: 400 });
  if (!bucket || !ALLOWED_BUCKETS[bucket]) return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) return NextResponse.json({ error: "File type not allowed" }, { status: 422 });
  const maxBytes = ALLOWED_BUCKETS[bucket].maxMB * 1024 * 1024;
  if (file.size > maxBytes) return NextResponse.json({ error: `File must be under ${ALLOWED_BUCKETS[bucket].maxMB} MB` }, { status: 422 });

  const key = scopedKey("group", { group_id: params.id }, file);
  const buffer = Buffer.from(await file.arrayBuffer());
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: file.type }));

  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  const displayName = cleanDisplayName(file.name.replace(/[^a-zA-Z0-9._-]/g, "_"));
  const admin = createAdminSupabaseClient();
  const { data: row, error: dbErr } = await admin
    .from("image_library")
    .upsert({
      bucket, s3_key: key, url, display_name: displayName, file_size: file.size,
      uploaded_by: claims!.sub, scope: "group", group_id: params.id,
    }, { onConflict: "bucket,s3_key" })
    .select("id, bucket, s3_key, url, display_name, file_size, uploaded_at")
    .single();

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ image: row }, { status: 201 });
}

/** DELETE /api/groups/[id]/images?imageId=… */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorize(params.id);
  if (error) return error;

  const imageId = req.nextUrl.searchParams.get("imageId");
  if (!imageId) return NextResponse.json({ error: "imageId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: row } = await admin
    .from("image_library")
    .select("id, bucket, s3_key, scope, group_id")
    .eq("id", imageId)
    .maybeSingle<{ id: string; bucket: string; s3_key: string; scope: string; group_id: string | null }>();
  // Scope guard: only a group image belonging to THIS group.
  if (!row || row.scope !== "group" || row.group_id !== params.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await Promise.all([
    s3Client().send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.s3_key })).catch(() => null),
    admin.from("image_library").delete().eq("id", imageId),
  ]);
  return NextResponse.json({ ok: true });
}

/** PATCH /api/groups/[id]/images?imageId=…  { display_name } */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { error } = await authorize(params.id);
  if (error) return error;

  const imageId = req.nextUrl.searchParams.get("imageId");
  if (!imageId) return NextResponse.json({ error: "imageId required" }, { status: 400 });

  let body: { display_name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const displayName = body.display_name?.trim();
  if (!displayName) return NextResponse.json({ error: "display_name required" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data: row } = await admin
    .from("image_library")
    .select("id, scope, group_id")
    .eq("id", imageId)
    .maybeSingle<{ id: string; scope: string; group_id: string | null }>();
  if (!row || row.scope !== "group" || row.group_id !== params.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await admin.from("image_library").update({ display_name: displayName }).eq("id", imageId);
  return NextResponse.json({ ok: true, display_name: displayName });
}
