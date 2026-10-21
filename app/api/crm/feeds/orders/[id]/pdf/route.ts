import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadOrder } from "@/lib/crm/feeds/orders";
import { signCrmKey } from "@/lib/crm/recordings";
import { feedErrorResponse } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/feeds/orders/[id]/pdf?which=request|signed — 302 to a signed S3 URL. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  try {
    const order = await loadOrder(createAdminSupabaseClient() as any, params.id);
    const key = req.nextUrl.searchParams.get("which") === "signed" ? order.signed_pdf_s3_key : order.pdf_s3_key;
    if (!key) return NextResponse.json({ error: "No PDF yet" }, { status: 404 });
    return NextResponse.redirect(await signCrmKey(key), 302);
  } catch (e) { return feedErrorResponse(e); }
}
