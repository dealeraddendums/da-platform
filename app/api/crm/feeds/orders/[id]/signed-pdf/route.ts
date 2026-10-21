import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadOrder, recordEvent, storeOrderPdf } from "@/lib/crm/feeds/orders";
import { feedErrorResponse } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** POST /api/crm/feeds/orders/[id]/signed-pdf (multipart: file) — the dealer's signed copy (also saved to the company's Files). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  try {
    const order = await loadOrder(admin, params.id);
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return NextResponse.json({ error: "file required" }, { status: 400 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "Upload a PDF" }, { status: 400 });
    if (file.size > 25 * 1024 * 1024) return NextResponse.json({ error: "PDF is larger than 25 MB" }, { status: 400 });
    await storeOrderPdf(admin, order, file.name || "signed.pdf", Buffer.from(await file.arrayBuffer()), "signed_pdf_s3_key", claims.sub);
    await recordEvent(admin, order, "signed_pdf_uploaded", { note: file.name }, claims.sub);
    await admin.from("crm_feed_orders").update({ stall_timer_started_at: new Date().toISOString(), stalled_nudges: 0 }).eq("id", order.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return feedErrorResponse(e); }
}
