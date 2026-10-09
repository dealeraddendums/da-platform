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
  /** Group Image Builder: write into THIS group's image library (scope='group');
   *  dealer Image Builder: THIS dealer's My Images (scope='dealer', text
   *  dealer_id). Same key + row shape as a library upload in that scope.
   *  Omitted = the platform library, exactly as before. */
  owner?: { groupId: string } | { dealerTextId: string },
): Promise<{ id: string; url: string; display_name: string; bucket: string; s3_key: string }> {
  const bucket = IMAGE_TYPES[imageType].bucket;
  const cleanName = `${name.trim() || "image"}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) + ".png";
  const file = { name: cleanName, type: "image/png" };
  const key = owner && "groupId" in owner ? scopedKey("group", { group_id: owner.groupId }, file)
    : owner && "dealerTextId" in owner ? scopedKey("dealer", { dealer_id: owner.dealerTextId }, file)
    : `${Date.now()}_${cleanName}`;
  await s3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: "image/png" }));
  const url = `https://${bucket}.s3.${REGION}.amazonaws.com/${key}`;
  const displayName = cleanName.replace(/\.png$/, "");
  const { data, error } = await builderDb()
    .from("image_library")
    .upsert(
      {
        bucket, s3_key: key, url, display_name: displayName, file_size: bytes.length, uploaded_by: uploadedBy,
        ...(owner && "groupId" in owner ? { scope: "group", group_id: owner.groupId } : {}),
        ...(owner && "dealerTextId" in owner ? { scope: "dealer", dealer_id: owner.dealerTextId } : {}),
      },
      { onConflict: "bucket,s3_key" },
    )
    .select("id, url, display_name, bucket, s3_key")
    .single();
  if (error || !data) throw new Error(error?.message ?? "image_library write failed");
  return data;
}

/**
 * Seed a group's "My designs" with its own editable copies of the platform
 * starter templates — once per group, the first time its Image Builder is
 * opened (Allan, 2026-10-07: groups start from the base images, as their OWN
 * designs, not a read-only starter section).
 *
 * Once-only is enforced by an admin_settings marker inserted FIRST (primary
 * key → a concurrent second opener gets 23505 and skips), so a design the group
 * later deletes never comes back. Copies are inserted in ONE statement; if that
 * fails the marker is removed so the next open retries cleanly (no partial set).
 */
export async function ensureGroupSeeded(groupId: string, userId: string): Promise<number> {
  return ensureOwnerSeeded({ groupId }, userId);
}

/** Same once-only seeding for a DEALER's Image Builder (dealer_uuid owner). */
export async function ensureDealerSeeded(dealerUuid: string, userId: string): Promise<number> {
  return ensureOwnerSeeded({ dealerUuid }, userId);
}

async function ensureOwnerSeeded(owner: { groupId: string } | { dealerUuid: string }, userId: string): Promise<number> {
  const db = builderDb();
  const isGroup = "groupId" in owner;
  const ownerId = isGroup ? owner.groupId : owner.dealerUuid;
  const key = isGroup ? `image_builder_seeded:${ownerId}` : `image_builder_seeded:dealer:${ownerId}`;
  const { error: markErr } = await db.from("admin_settings").insert({ key, value: new Date().toISOString() });
  if (markErr) {
    if (markErr.code === "23505") return 0; // already seeded (or seeding right now)
    throw new Error(markErr.message);
  }
  const { data: starters, error: sErr } = await db
    .from("image_designs").select("name, image_type, design_json")
    .eq("is_template", true).is("group_id", null).is("dealer_uuid", null).order("created_at", { ascending: true });
  if (sErr || !starters?.length) {
    if (sErr) await db.from("admin_settings").delete().eq("key", key);
    return 0;
  }
  const { data: rows, error: insErr } = await db.from("image_designs").insert(
    starters.map((s: { name: string; image_type: string; design_json: DesignDoc }) => ({
      group_id: isGroup ? ownerId : null, dealer_uuid: isGroup ? null : ownerId,
      name: s.name, image_type: s.image_type, design_json: s.design_json,
      is_template: false, replaces_image_id: null, created_by: userId,
    })),
  ).select("id, design_json");
  if (insErr || !rows) {
    await db.from("admin_settings").delete().eq("key", key);
    throw new Error(insErr?.message ?? "seed insert failed");
  }
  for (const r of rows as { id: string; design_json: DesignDoc }[]) await writeVersion(r.id, r.design_json, userId);
  audit(userId, isGroup ? "image_designs_group_seeded" : "image_designs_dealer_seeded", isGroup ? { group_id: ownerId, count: rows.length } : { dealer_uuid: ownerId, count: rows.length });
  return rows.length;
}
