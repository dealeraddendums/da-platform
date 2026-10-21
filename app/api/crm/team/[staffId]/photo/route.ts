import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { putCrmObject, signCrmKey } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET — the member's photo (302 to a signed URL). */
export async function GET(_req: NextRequest, { params }: { params: { staffId: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data } = await admin.from("crm_staff_profiles").select("photo_s3_key").eq("staff_id", params.staffId).maybeSingle();
  if (!data?.photo_s3_key) return NextResponse.json({ error: "No photo" }, { status: 404 });
  return NextResponse.redirect(await signCrmKey(data.photo_s3_key, undefined, 3600), 302);
}

/** POST (multipart: file) — self or crm_admin; PNG/JPEG/WebP ≤ 5 MB. */
export async function POST(req: NextRequest, { params }: { params: { staffId: string } }): Promise<NextResponse> {
  const { claims, perms, error } = await requireCrmStaff();
  if (error) return error;
  if (claims.sub !== params.staffId && !perms.crmAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "file required" }, { status: 400 });
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return NextResponse.json({ error: "PNG, JPEG or WebP only" }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return NextResponse.json({ error: "Photo is larger than 5 MB" }, { status: 400 });

  const admin = createAdminSupabaseClient() as any;
  const key = `crm/team/${params.staffId}/${randomUUID()}.${file.type.split("/")[1]}`;
  await putCrmObject(key, Buffer.from(await file.arrayBuffer()), file.type);
  const { error: upErr } = await admin.from("crm_staff_profiles").update({ photo_s3_key: key }).eq("staff_id", params.staffId);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
