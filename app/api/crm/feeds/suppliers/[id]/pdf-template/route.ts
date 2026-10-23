import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { putCrmObject } from "@/lib/crm/recordings";
import { pdfFieldNames } from "@/lib/crm/feeds/pdf";
import { UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** POST /api/crm/feeds/suppliers/[id]/pdf-template (multipart: file) — crm_admin. Stores the fillable PDF, returns its field names. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff({ admin: true });
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  const { data: co } = await admin.from("crm_companies").select("kind").eq("id", params.id).maybeSingle();
  if (co?.kind !== "feed_supplier") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string" || file.type !== "application/pdf") return NextResponse.json({ error: "Upload a PDF" }, { status: 400 });
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "PDF is larger than 10 MB" }, { status: 400 });
  const bytes = Buffer.from(await file.arrayBuffer());
  let fields: string[];
  try { fields = await pdfFieldNames(bytes); } catch { return NextResponse.json({ error: "That PDF couldn't be read" }, { status: 400 }); }
  if (!fields.length) return NextResponse.json({ error: "That PDF has no fillable fields — ask the supplier for the fillable version" }, { status: 400 });
  const key = `crm/${params.id}/files/${randomUUID()}/feed-template.pdf`;
  await putCrmObject(key, bytes, "application/pdf");
  await admin.from("crm_feed_supplier_settings").upsert({ company_id: params.id, pdf_template_s3_key: key, updated_by: claims.sub }, { onConflict: "company_id" });
  return NextResponse.json({ ok: true, fields });
}
