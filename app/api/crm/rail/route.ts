import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { CALL_COLUMNS, canDial, decorateCalls, staffNames } from "@/lib/crm/queries";
import { decorateOrders, parentsOf } from "@/lib/crm/feeds/queue";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/crm/rail?company_id=&contact_id= — everything CompanyContextRail
 * shows: company (+ trial stage), contact, contacts, open tickets / tasks,
 * recent calls, recent email threads, feed orders (open one first)
 * and whether this staff member can click-to-call. A contact implies its company.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const sp = req.nextUrl.searchParams;
  let companyId = UUID.test(sp.get("company_id") ?? "") ? sp.get("company_id")! : null;
  const contactId = UUID.test(sp.get("contact_id") ?? "") ? sp.get("contact_id")! : null;

  const contact = contactId
    ? (await admin.from("crm_contacts").select("id, company_id, first_name, last_name, email, phone, title, role_tag").eq("id", contactId).is("deleted_at", null).maybeSingle()).data
    : null;
  companyId = companyId ?? contact?.company_id ?? null;
  const dial = await canDial(claims.sub, admin);
  if (!companyId) return NextResponse.json({ company: null, contact, canDial: dial });

  const [{ data: dir }, { data: co }, { data: contacts }, { data: tickets }, { data: tasks }, { data: calls }, { data: threads }, staff, { data: orders }] = await Promise.all([
    admin.from("crm_company_directory").select("id, kind, name, dealer_text_id, city, state, phone, account_type, active, pipeline_stage, stage_changed_at, trial_day, trial_ends_on, trial_flag, owner_staff_id, last_activity_at").eq("id", companyId).maybeSingle(),
    admin.from("crm_companies").select("website, emails").eq("id", companyId).maybeSingle(),
    admin.from("crm_contacts").select("id, first_name, last_name, email, phone, title, role_tag").eq("company_id", companyId).is("deleted_at", null).order("first_name").limit(25),
    admin.from("crm_tickets").select("id, title, status, assigned_staff_id, created_at").eq("company_id", companyId).in("status", ["open", "pending"]).order("created_at", { ascending: false }).limit(10),
    admin.from("crm_tasks").select("id, title, status, assigned_staff_id, created_at").eq("company_id", companyId).eq("status", "open").order("created_at", { ascending: false }).limit(10),
    admin.from("crm_calls").select(CALL_COLUMNS).eq("company_id", companyId).order("started_at", { ascending: false, nullsFirst: false }).limit(5),
    admin.from("crm_email_threads").select("id, subject, status, last_message_at, last_direction, unread").eq("company_id", companyId).order("last_message_at", { ascending: false }).limit(5),
    staffNames(admin),
    // The company's orders, and group orders one of its dealerships is on (child rows → their parent).
    admin.from("crm_feed_orders").select("*").eq("dealer_company_id", companyId).order("created_at", { ascending: false }).limit(10),
  ]);
  if (!dir) return NextResponse.json({ company: null, contact, canDial: dial });

  return NextResponse.json({
    company: { ...dir, website: co?.website ?? null, emails: co?.emails ?? [], owner_name: dir.owner_staff_id ? staff[dir.owner_staff_id] ?? null : null },
    contact,
    contacts: contacts ?? [],
    tickets: (tickets ?? []).map((t: any) => ({ ...t, assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null })),
    tasks: (tasks ?? []).map((t: any) => ({ ...t, assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null })),
    calls: await decorateCalls(calls ?? [], admin),
    threads: threads ?? [],
    // Open order first, then the most recent closed ones.
    feedOrders: await decorateOrders(admin, (await parentsOf(admin, orders ?? [])).sort((a: any, b: any) => Number(["done", "cancelled"].includes(a.status)) - Number(["done", "cancelled"].includes(b.status)) || String(b.created_at).localeCompare(String(a.created_at))).slice(0, 5)),
    canDial: dial,
  });
}
