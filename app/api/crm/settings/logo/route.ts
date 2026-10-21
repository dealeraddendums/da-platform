import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { putCrmObject, signCrmKey } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET — the DA-CRM logo (302 to a signed URL), 404 when none is set. */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data } = await admin.from("crm_settings").select("logo_s3_key").eq("id", true).maybeSingle();
  if (!data?.logo_s3_key) return NextResponse.json({ error: "No logo" }, { status: 404 });
  return NextResponse.redirect(await signCrmKey(data.logo_s3_key, undefined, 3600), 302);
}

/** POST (crm_admin, multipart: file) — PNG/JPEG/WebP ≤ 2 MB. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "file required" }, { status: 400 });
  // No SVG: an SVG served from our bucket can carry script.
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return NextResponse.json({ error: "PNG, JPEG or WebP only" }, { status: 400 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "Logo is larger than 2 MB" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const key = `crm/settings/logo-${randomUUID()}.${file.type.split("/")[1]}`;
  await putCrmObject(key, Buffer.from(await file.arrayBuffer()), file.type);
  const { error: upErr } = await admin.from("crm_settings").update({ logo_s3_key: key, updated_by: claims.sub }).eq("id", true);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
