import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadOrder, missingInfo, supplierSettings, updateOrderInfo } from "@/lib/crm/feeds/orders";
import { decorateOrders } from "@/lib/crm/feeds/queue";
import { feedErrorResponse, UUID } from "@/lib/crm/feeds/http";
import { staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/feeds/orders/[id] — order slide-over: order row, events, tasks, supplier settings. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  try {
    const order = await loadOrder(admin, params.id);
    const [[row], { data: events }, { data: tasks }, settings, staff, { data: me }] = await Promise.all([
      decorateOrders(admin, [order]),
      admin.from("crm_feed_order_events").select("id, type, detail, actor, occurred_at").eq("order_id", order.id).order("occurred_at"),
      admin.from("crm_tasks").select("id, title, description, kind, status, due_at, assigned_staff_id, assigned_capability, created_at, completed_at").eq("feed_order_id", order.id).order("created_at"),
      supplierSettings(admin, order.supplier_company_id),
      staffNames(admin),
      admin.from("crm_staff_profiles").select("feed_send_without_review").eq("staff_id", claims.sub).maybeSingle(),
    ]);
    return NextResponse.json({
      order: { ...order, ...row }, settings, missing: missingInfo(order, settings?.request_method ?? null),
      events: (events ?? []).map((e: any) => ({ ...e, actor_name: e.actor === "system" ? "DA-CRM" : staff[e.actor] ?? "Staff" })),
      tasks: (tasks ?? []).map((t: any) => ({ ...t, assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null })),
      sendWithoutReview: !!me?.feed_send_without_review,
      staff: Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) { return feedErrorResponse(e); }
}

/** PATCH /api/crm/feeds/orders/[id] — { supplier_company_id?, approver_name?, approver_email?, approver_phone? } (Change approver etc.). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const fields: Record<string, any> = {};
  for (const k of ["supplier_company_id", "approver_name", "approver_email", "approver_phone"]) if (k in b) fields[k] = typeof b[k] === "string" ? b[k] : null;
  if (!Object.keys(fields).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, order: await updateOrderInfo(createAdminSupabaseClient() as any, params.id, fields, claims.sub) });
  } catch (e) { return feedErrorResponse(e); }
}
