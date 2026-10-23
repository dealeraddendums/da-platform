import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { composeEmail, senderSignature, staffIdentity } from "@/lib/crm/email-compose";
import { signatureEmailHtml, wrapEmail } from "@/lib/crm/email-html";
import { DEFAULT_SIGNATURE_TEMPLATE, renderSignature, type SignatureCta } from "@/lib/crm/signature";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Signature as it will go out. Both return a whole email body (font wrapper + signature) so the preview
 * frame shows exactly the markup that is sent — no app CSS, no inherited fonts.
 *   GET  ?staff_id=  (default: me) → composeEmail() itself with an empty body: what that sender's emails
 *        carry right now (compose window block)
 *   POST { staff_id, template, cta } → an unsaved draft rendered for any team member (Team → Signature),
 *        through the same signature sanitizer + wrapper composeEmail uses
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const staffId = req.nextUrl.searchParams.get("staff_id") ?? claims.sub;
  if (!UUID.test(staffId)) return NextResponse.json({ error: "Bad staff_id" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const sig = await senderSignature(admin, staffId);
  if (!sig.html) return NextResponse.json({ html: null, source: sig.source });
  const email = await composeEmail({ subject: "", bodyHtml: "", staffId }, admin);
  return NextResponse.json({ html: email.html, source: sig.source });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const staffId = typeof b?.staff_id === "string" && UUID.test(b.staff_id) ? b.staff_id : claims.sub;
  const admin = createAdminSupabaseClient() as any;
  const me = await staffIdentity(admin, staffId);
  const template = typeof b?.template === "string" && b.template.trim() ? b.template.slice(0, 20000) : DEFAULT_SIGNATURE_TEMPLATE;
  const html = renderSignature(template, { full_name: me.fullName, title: me.title, phone: me.phone }, (b?.cta ?? null) as SignatureCta | null);
  return NextResponse.json({ html: wrapEmail("", signatureEmailHtml(html)), staff: { full_name: me.fullName, title: me.title, phone: me.phone } });
}
