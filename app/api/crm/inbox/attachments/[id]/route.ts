import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { signCrmKey } from "@/lib/crm/recordings";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/crm/inbox/attachments/[id] — 302 to a 15-minute signed S3 URL (images inline, the rest as a download). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  const { data: a } = await admin.from("crm_email_attachments").select("filename, content_type, s3_key").eq("id", params.id).maybeSingle();
  if (!a?.s3_key) return NextResponse.json({ error: "Not available — open it in Outlook" }, { status: 404 });
  const inline = /^image\/(png|jpe?g|gif|webp)$/i.test(a.content_type ?? "");
  return NextResponse.redirect(await signCrmKey(a.s3_key, inline ? undefined : a.filename), 302);
}
