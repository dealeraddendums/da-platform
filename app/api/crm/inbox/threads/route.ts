import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { companyNames, staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const INBOX_VIEWS = ["unassigned", "mine", "open", "waiting", "closed", "all"] as const;
type View = (typeof INBOX_VIEWS)[number];
const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function applyView(q: any, view: View, me: string): any {
  switch (view) {
    case "unassigned": return q.is("company_id", null).eq("internal", false).neq("status", "closed");
    case "mine": return q.eq("assigned_staff_id", me).neq("status", "closed");
    case "open": return q.eq("status", "open");
    case "waiting": return q.eq("status", "waiting_on_dealer");
    case "closed": return q.eq("status", "closed");
    default: return q;
  }
}

/**
 * GET /api/crm/inbox/threads — the Inbox thread list.
 * ?view=unassigned|mine|open|waiting|closed|all (default open) &mailbox={id}
 * &q= (subject / participant address) &page= &company_id= &contact_id=
 * Returns threads, per-view counts (same mailbox filter), mailboxes, staff.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  const admin = createAdminSupabaseClient() as any;
  const sp = req.nextUrl.searchParams;
  const view = (INBOX_VIEWS as readonly string[]).includes(sp.get("view") ?? "") ? (sp.get("view") as View) : "open";
  const mailbox = UUID.test(sp.get("mailbox") ?? "") ? sp.get("mailbox")! : null;
  const companyId = UUID.test(sp.get("company_id") ?? "") ? sp.get("company_id")! : null;
  const contactId = UUID.test(sp.get("contact_id") ?? "") ? sp.get("contact_id")! : null;
  const page = Math.max(0, Number(sp.get("page")) || 0);
  const term = (sp.get("q") ?? "").trim().replace(/[%_,()\\*]/g, " ").slice(0, 80);

  let ids: string[] | null = null;
  if (term.length >= 2) {
    const { data: hits } = await admin.from("crm_email_participants").select("thread_id").ilike("address", `%${term}%`).limit(300);
    ids = Array.from(new Set((hits ?? []).map((h: any) => h.thread_id)));
  }
  const scoped = (q: any) => {
    if (mailbox) q = q.eq("mailbox_id", mailbox);
    if (companyId) q = q.eq("company_id", companyId);
    if (contactId) q = q.eq("contact_id", contactId);
    if (term.length >= 2) q = ids!.length ? q.or(`subject.ilike.%${term}%,id.in.(${ids!.join(",")})`) : q.ilike("subject", `%${term}%`);
    return q;
  };

  const listQ = applyView(scoped(admin.from("crm_email_threads").select(
    "id, mailbox_id, subject, status, unread, internal, last_message_at, last_direction, last_from_email, last_from_name, last_snippet, message_count, company_id, contact_id, assigned_staff_id, match_candidates",
    { count: "exact" })), view, claims.sub)
    .order("last_message_at", { ascending: false, nullsFirst: false }).range(page * PAGE, page * PAGE + PAGE - 1);

  const counts = Promise.all(INBOX_VIEWS.map(async (v) => {
    const { count } = await applyView(scoped(admin.from("crm_email_threads").select("id", { count: "exact", head: true })), v, claims.sub);
    return [v, count ?? 0] as const;
  }));

  const [{ data: rows, count, error: qErr }, viewCounts, { data: mailboxes }, staff] = await Promise.all([
    listQ, counts,
    admin.from("crm_mailboxes").select("id, address, display_name, purpose, active, last_synced_at, last_error").order("address"),
    staffNames(admin),
  ]);
  if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });

  const threads: any[] = rows ?? [];
  const contactIds = Array.from(new Set(threads.map((t) => t.contact_id).filter(Boolean)));
  const [names, contacts] = await Promise.all([
    companyNames(threads.map((t) => t.company_id), admin),
    contactIds.length ? admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", contactIds).then((r: any) => r.data ?? []) : [],
  ]);
  const cName = Object.fromEntries(contacts.map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email]));
  const mb = Object.fromEntries((mailboxes ?? []).map((m: any) => [m.id, m.address]));

  return NextResponse.json({
    view, page, pageSize: PAGE, total: count ?? 0,
    counts: Object.fromEntries(viewCounts),
    mailboxes: mailboxes ?? [],
    staff: Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    threads: threads.map((t) => ({
      ...t,
      mailbox: mb[t.mailbox_id] ?? null,
      company_name: t.company_id ? names[t.company_id] ?? null : null,
      contact_name: t.contact_id ? cName[t.contact_id] ?? null : null,
      assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null,
    })),
  });
}
