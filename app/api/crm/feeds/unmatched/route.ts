import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadParent, recordEvent } from "@/lib/crm/feeds/orders";
import { handleFeedsEmail } from "@/lib/crm/feeds/inbound";
import { feedErrorResponse, UUID } from "@/lib/crm/feeds/http";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/feeds/unmatched — feeds@ mail no order matched (newest first). */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const { data } = await admin.from("crm_feed_unmatched").select("id, email_id, thread_id, reason, created_at").is("resolved_at", null).order("created_at", { ascending: false }).limit(200);
  const ids = (data ?? []).map((u: any) => u.email_id);
  const { data: emails } = ids.length ? await admin.from("crm_emails").select("id, from_email, from_name, subject, received_at, body_text").in("id", ids) : { data: [] };
  const byId = Object.fromEntries((emails ?? []).map((e: any) => [e.id, e]));
  return NextResponse.json({ rows: (data ?? []).map((u: any) => ({ ...u, email: byId[u.email_id] ? { ...byId[u.email_id], body_text: String(byId[u.email_id].body_text ?? "").slice(0, 400) } : null })) });
}

/**
 * POST /api/crm/feeds/unmatched { id, order_id } — link the message (and its
 * thread) to an order, then run detection on it as if it had matched. { id, dismiss: true } clears it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  if (!UUID.test(b?.id ?? "")) return NextResponse.json({ error: "id required" }, { status: 400 });
  const admin = createAdminSupabaseClient() as any;
  const { data: u } = await admin.from("crm_feed_unmatched").select("*").eq("id", b.id).maybeSingle();
  if (!u) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const now = new Date().toISOString();
  if (b.dismiss) {
    await admin.from("crm_feed_unmatched").update({ resolved_at: now, resolved_by: claims.sub }).eq("id", u.id);
    return NextResponse.json({ ok: true });
  }
  if (!UUID.test(b.order_id ?? "")) return NextResponse.json({ error: "order_id required" }, { status: 400 });
  try {
    const order = await loadParent(admin, b.order_id);
    if (!order.email_thread_id) await admin.from("crm_feed_orders").update({ email_thread_id: u.thread_id }).eq("id", order.id);
    await admin.from("crm_email_threads").update({ company_id: order.dealer_company_id, matched_by: "manual", match_candidates: [] }).eq("id", u.thread_id).is("company_id", null);
    await admin.from("crm_feed_unmatched").delete().eq("id", u.id);   // otherwise detection sees it as already handled
    const [{ data: e }, { data: t }, { data: mb }] = await Promise.all([
      admin.from("crm_emails").select("*").eq("id", u.email_id).single(),
      admin.from("crm_email_threads").select("id, company_id, contact_id, subject, status, internal, message_count").eq("id", u.thread_id).single(),
      admin.from("crm_mailboxes").select("id, address, purpose").eq("purpose", "feeds").limit(1).single(),
    ]);
    await recordEvent(admin, order, "unmatched_linked", { thread_id: t.id }, claims.sub);
    const outcome = await handleFeedsEmail({ email: { ...e, to: e.to ?? [], cc: e.cc ?? [] }, thread: t, mailbox: mb }, admin, { orderId: order.id });
    await admin.from("crm_feed_unmatched").upsert({ email_id: u.email_id, thread_id: u.thread_id, reason: u.reason, resolved_at: now, resolved_order_id: order.id, resolved_by: claims.sub }, { onConflict: "email_id" });
    return NextResponse.json({ ok: true, outcome });
  } catch (err) { return feedErrorResponse(err); }
}
