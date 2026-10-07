// Image Builder — server-side persistence + export validation.
//
// Export reuses the Image Library's storage exactly: same S3 buckets, same
// root-level `{timestamp}_{name}.png` key shape the library listing reads, same
// image_library row upsert. Every export is a NEW key, so a library PNG is
// never overwritten.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { REGION, s3Client, scopedKey } from "@/lib/image-library";
import { fireWrite } from "@/lib/db";
import { builderDb } from "./access";
import { IMAGE_TYPES, type DesignDoc, type ImageType } from "./spec";

export { checkExport } from "./export-check";

export const DESIGN_LIST_COLUMNS =
  "id, dealer_uuid, group_id, image_type, name, is_template, exported_image_id, replaces_image_id, created_by, created_at, updated_at";

/**
 * Append a version row for `designId` holding `doc`. Version numbers are
 * per-design and gapless; a concurrent save that collides on the
 * (design_id, version_no) unique key retries with the next number.
 */
export async function writeVersion(designId: string, doc: DesignDoc, savedBy: string): Promise<number> {
  const db = builderDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: last } = await db
      .from("image_design_versions")
      .select("version_no")
      .eq("design_id", designId)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = (last?.version_no ?? 0) + 1;
    const { error } = await db
      .from("image_design_versions")
      .insert({ design_id: designId, version_no: next, design_json: doc, saved_by: savedBy });
    if (!error) return next;
    if (error.code !== "23505") throw new Error(error.message);
  }
  throw new Error("Could not allocate a version number");
}

export function audit(actor: string, action: string, metadata: Record<string, unknown>): void {
  fireWrite(builderDb().from("admin_audit").insert({ admin_user_id: actor, action, metadata }), "admin_audit");
}

/** Upload a validated PNG into the Image Library tab for `imageType`. */
export async function saveToLibrary(
  bytes: Uint8Array,
  imageType: ImageType,
  name: string,
  uploadedBy: string,
  /** Group Image Builder: write into THIS group's image library (scope='group'),
   *  the same key shape + row shape as a Group Image Library upload. Omitted =
   *  the platform library, exactly as before. */
  groupId?: string,
): Promise<{ id: string; url: string; display_name: string; bucket: string; s3_key: string }> {
  const bucket = IMAGE_TYPES[imageType].bucket;
  const cleanName = `${name.trim() || "image"}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) + ".png";
  const key = groupId ? scopedKey("group", { group_id: groupId }, { name: cleanName, type: "image/png" }) : `${Date.now()}_${cleanName}`;
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: "image/png" }));
  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  const displayName = cleanName.replace(/\.png$/, "");
  const { data, error } = await builderDb()
    .from("image_library")
    .upsert(
      {
        bucket, s3_key: key, url, display_name: displayName, file_size: bytes.length, uploaded_by: uploadedBy,
        ...(groupId ? { scope: "group", group_id: groupId } : {}),
      },
      { onConflict: "bucket,s3_key" },
    )
    .select("id, url, display_name, bucket, s3_key")
    .single();
  if (error || !data) throw new Error(error?.message ?? "image_library write failed");
  return data;
}
