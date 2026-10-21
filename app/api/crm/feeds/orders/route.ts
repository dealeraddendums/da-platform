import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { createFeedOrder } from "@/lib/crm/feeds/orders";
import { FEED_VIEWS, queueCounts, queueRows, type FeedView } from "@/lib/crm/feeds/queue";
import { feedErrorResponse, str, UUID } from "@/lib/crm/feeds/http";
import { staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/crm/feeds/orders?view=mine|needs_info|stalled|awaiting_confirmation|all
 * (&dealer_company_id=) — the Feeds queue (+ counts, staff). Unmatched: /api/crm/feeds/unmatched.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const sp = req.nextUrl.searchParams;
  const view = ((FEED_VIEWS as readonly string[]).includes(sp.get("view") ?? "") ? sp.get("view") : "all") as FeedView;
  const dealer = UUID.test(sp.get("dealer_company_id") ?? "") ? sp.get("dealer_company_id")! : undefined;
  const [rows, counts, staff] = await Promise.all([
    view === "unmatched" ? Promise.resolve([]) : queueRows(admin, view, claims.sub, { dealerCompanyId: dealer }),
    dealer ? Promise.resolve(null) : queueCounts(admin, claims.sub),
    staffNames(admin),
  ]);
  return NextResponse.json({ view, rows, counts, staff: Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)) });
}

/**
 * POST /api/crm/feeds/orders — Start feed order (rail, thread, chat, company page).
 * { dealer_company_id, supplier_company_id?, approver_name?, approver_email?, approver_phone?, notes?,
 *   source?: call|chat|email, email_thread_id? } — every field but the dealer optional;
 * gaps → needs_info + "call the GM" task. Returns the open order if one exists.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (!UUID.test(b?.dealer_company_id ?? "")) return NextResponse.json({ error: "dealer_company_id required" }, { status: 400 });
  const source = ["call", "chat", "email"].includes(b.source) ? b.source : "call";
  try {
    const r = await createFeedOrder(createAdminSupabaseClient() as any, {
      dealerCompanyId: b.dealer_company_id, supplierCompanyId: UUID.test(b.supplier_company_id ?? "") ? b.supplier_company_id : null,
      source, initiatedBy: claims.sub, approverName: str(b.approver_name, 200), approverEmail: str(b.approver_email, 200),
      approverPhone: str(b.approver_phone, 40), notes: str(b.notes, 4000), emailThreadId: UUID.test(b.email_thread_id ?? "") ? b.email_thread_id : null,
    });
    return NextResponse.json({ ok: true, order: r.order, existed: r.existed });
  } catch (e) { return feedErrorResponse(e); }
}
