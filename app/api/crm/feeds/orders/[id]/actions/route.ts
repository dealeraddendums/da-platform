import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { cancelOrder, confirmFeedId, enterFeedId, forwardSignedPdf, markDealerApproved, nudge, reassignOwner, sendRequest } from "@/lib/crm/feeds/orders";
import { feedErrorResponse, str, UUID } from "@/lib/crm/feeds/http";
import { staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/feeds/orders/[id]/actions { action, … } — every row / slide-over
 * / rail action. Each one logs an event and restarts the stall timer.
 *   send · resend           { subject?, body_html? }  (edited in the review slide-over)
 *   nudge_dealer · nudge_supplier · mark_approved { note? }
 *   enter_feed_id { feed_id } · confirm_feed_id { feed_id }
 *   reassign { owner_staff_id } · cancel { reason } · forward_signed_pdf
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  const me = claims.sub;
  try {
    let order: any;
    switch (b?.action) {
      case "send":
      case "resend": {
        const override = typeof b.body_html === "string" ? { subject: str(b.subject, 300) ?? undefined, bodyHtml: b.body_html.slice(0, 200_000) } : undefined;
        order = await sendRequest(admin, params.id, me, { resend: b.action === "resend", override });
        break;
      }
      case "nudge_dealer": order = await nudge(admin, params.id, "dealer", me, true); break;
      case "nudge_supplier": order = await nudge(admin, params.id, "supplier", me, true); break;
      case "mark_approved": order = await markDealerApproved(admin, params.id, me, str(b.note, 1000) ?? undefined); break;
      case "enter_feed_id": {
        const id = str(b.feed_id, 60);
        if (!id) return NextResponse.json({ error: "feed_id required" }, { status: 400 });
        order = await enterFeedId(admin, params.id, id, me);
        break;
      }
      case "confirm_feed_id": {
        const id = str(b.feed_id, 60);
        if (!id) return NextResponse.json({ error: "feed_id required" }, { status: 400 });
        order = await confirmFeedId(admin, params.id, id, me);
        break;
      }
      case "reassign": {
        const owner = typeof b.owner_staff_id === "string" ? b.owner_staff_id : null;
        if (owner && !(await staffNames(admin))[owner]) return NextResponse.json({ error: "Not a DA-CRM team member" }, { status: 400 });
        order = await reassignOwner(admin, params.id, owner, me);
        break;
      }
      case "cancel": {
        const reason = str(b.reason, 1000);
        if (!reason) return NextResponse.json({ error: "A cancel reason is required" }, { status: 400 });
        order = await cancelOrder(admin, params.id, reason, me);
        break;
      }
      case "forward_signed_pdf": await forwardSignedPdf(admin, params.id, me); break;
      default: return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, order: order ?? null });
  } catch (e) { return feedErrorResponse(e); }
}
