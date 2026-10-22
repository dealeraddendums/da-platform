import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { loadParent, orderMissingInfo, supplierSettings, updateOrderInfo } from "@/lib/crm/feeds/orders";
import { decorateOrders } from "@/lib/crm/feeds/queue";
import { feedErrorResponse, UUID } from "@/lib/crm/feeds/http";
import { staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET /api/crm/feeds/orders/[id] — order slide-over: order row (+ its dealerships), events and tasks (the order's and its dealerships'), supplier settings. A dealership's id opens its order. */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  try {
    const order = await loadParent(admin, params.id);
    const [row] = await decorateOrders(admin, [order]);
    const ids = [order.id, ...row.dealerships.map((d) => d.id)];
    const dname = Object.fromEntries(row.dealerships.map((d) => [d.id, d.name]));
    const [{ data: events }, { data: tasks }, settings, staff, { data: me }] = await Promise.all([
      admin.from("crm_feed_order_events").select("id, order_id, type, detail, actor, occurred_at").in("order_id", ids).order("occurred_at"),
      admin.from("crm_tasks").select("id, feed_order_id, title, description, kind, status, due_at, assigned_staff_id, assigned_capability, created_at, completed_at").in("feed_order_id", ids).order("created_at"),
      supplierSettings(admin, order.supplier_company_id),
      staffNames(admin),
      admin.from("crm_staff_profiles").select("feed_send_without_review").eq("staff_id", claims.sub).maybeSingle(),
    ]);
    return NextResponse.json({
      order: { ...order, ...row }, settings, missing: await orderMissingInfo(admin, order, settings),
      // Several dealerships: say which one an event / task is about.
      events: (events ?? []).map((e: any) => ({ ...e, dealership: row.dealerships.length > 1 ? dname[e.order_id] ?? null : null, actor_name: e.actor === "system" ? "DA-CRM" : staff[e.actor] ?? "Staff" })),
      tasks: (tasks ?? []).map((t: any) => ({ ...t, dealership: row.dealerships.length > 1 ? dname[t.feed_order_id] ?? null : null, assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null })),
      sendWithoutReview: !!me?.feed_send_without_review,
      staff: Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) { return feedErrorResponse(e); }
}

/** PATCH /api/crm/feeds/orders/[id] — { supplier_company_id?, approver_name?, approver_email?, approver_phone?, approver_title?, supplier_fields?, dealership_fields?: { [dealershipOrderId]: answers }, pdf_mode? } (Change approver, supplier questions…). */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const b = await req.json().catch(() => ({}));
  const fields: Record<string, any> = {};
  for (const k of ["supplier_company_id", "approver_name", "approver_email", "approver_phone", "approver_title"]) if (k in b) fields[k] = typeof b[k] === "string" ? b[k] : null;
  if ("supplier_fields" in b) fields.supplier_fields = b.supplier_fields && typeof b.supplier_fields === "object" && !Array.isArray(b.supplier_fields) ? b.supplier_fields : {};
  if (b.dealership_fields && typeof b.dealership_fields === "object" && !Array.isArray(b.dealership_fields)) fields.dealership_fields = b.dealership_fields;
  if (["per_dealership", "combined"].includes(b.pdf_mode)) fields.pdf_mode = b.pdf_mode;
  if (!Object.keys(fields).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, order: await updateOrderInfo(createAdminSupabaseClient() as any, params.id, fields, claims.sub) });
  } catch (e) { return feedErrorResponse(e); }
}
