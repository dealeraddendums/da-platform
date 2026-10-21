import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { putCrmObject } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/(plain|csv)|application\/(vnd\.openxmlformats-officedocument\.[a-z.]+|msword|vnd\.ms-excel|zip))$/;

/**
 * POST /api/crm/companies/[id]/files (multipart: file, label?) — attach a
 * file (e.g. a feed-request PDF). Stored at crm/{company_id}/files/{id}/{name}
 * and logged on the timeline as a 'file' activity.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data: c } = await admin.from("crm_companies").select("id").eq("id", params.id).maybeSingle();
  if (!c) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File is larger than 25 MB" }, { status: 400 });
  const type = file.type || "application/octet-stream";
  if (!ALLOWED.test(type)) return NextResponse.json({ error: `File type ${type} isn't allowed` }, { status: 400 });
  const label = String(form?.get("label") ?? "").trim().slice(0, 80) || null;
  const filename = (file.name || "file").replace(/[^\w.\- ()]+/g, "_").slice(0, 120);

  const id = randomUUID();
  const key = `crm/${c.id}/files/${id}/${filename}`;
  await putCrmObject(key, Buffer.from(await file.arrayBuffer()), type);
  const { error: insErr } = await admin.from("crm_company_files").insert({
    id, company_id: c.id, filename, content_type: type, size: file.size, s3_key: key, label, uploaded_by: claims.sub,
  });
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  await admin.from("crm_activities").insert({
    company_id: c.id, type: "file", direction: "internal",
    subject: `File attached: ${label ? `${label} — ` : ""}${filename}`,
    metadata: { file_id: id, filename, size: file.size }, actor_staff_id: claims.sub,
  });
  return NextResponse.json({ ok: true, id });
}
