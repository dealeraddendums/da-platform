import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { signCrmKey } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/files/[id] — download (302 to a 15-minute signed URL). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data: f } = await admin.from("crm_company_files").select("s3_key, filename").eq("id", params.id).is("deleted_at", null).maybeSingle();
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.redirect(await signCrmKey(f.s3_key, f.filename), 302);
}

/** DELETE /api/crm/files/[id] — soft delete (the S3 object is kept). */
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data: f } = await admin.from("crm_company_files").update({ deleted_at: new Date().toISOString() })
    .eq("id", params.id).is("deleted_at", null).select("company_id, filename").maybeSingle();
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await admin.from("crm_activities").insert({
    company_id: f.company_id, type: "file", direction: "internal",
    subject: `File removed: ${f.filename}`, metadata: { file_id: params.id, removed: true }, actor_staff_id: claims.sub,
  });
  return NextResponse.json({ ok: true });
}
