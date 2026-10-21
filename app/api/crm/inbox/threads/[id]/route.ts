import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { relinkThreadActivities } from "@/lib/crm/inbox-ingest";
import { displayEmailHtml } from "@/lib/crm/inbox-display";
import { companyNames, staffNames } from "@/lib/crm/queries";

export const dynamic = "force-dynamic";
/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["open", "waiting_on_dealer", "closed"];

/**
 * GET /api/crm/inbox/threads/[id] — a thread with its messages (oldest first,
 * display-sanitized HTML, attachments) and internal notes. Marks it read
 * unless ?peek=1.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admin = createAdminSupabaseClient() as any;
  const { data: t } = await admin.from("crm_email_threads").select("*").eq("id", params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [{ data: emails }, { data: notes }, { data: mailbox }, staff] = await Promise.all([
    admin.from("crm_emails").select("id, direction, from_email, from_name, to, cc, bcc, subject, body_html, body_text, received_at, sent_by_staff_id, is_reply_all, has_attachments, internet_message_id")
      .eq("thread_id", t.id).order("received_at").limit(200),
    admin.from("crm_activities").select("id, body, occurred_at, actor_staff_id").eq("type", "note").eq("metadata->>thread_id", t.id).order("occurred_at"),
    admin.from("crm_mailboxes").select("id, address, display_name, purpose").eq("id", t.mailbox_id).maybeSingle(),
    staffNames(admin),
  ]);
  const list: any[] = emails ?? [];
  const { data: atts } = list.length
    ? await admin.from("crm_email_attachments").select("id, email_id, filename, content_type, size, is_inline, content_id, s3_key").in("email_id", list.map((e) => e.id))
    : { data: [] };
  const byEmail: Record<string, any[]> = {};
  for (const a of atts ?? []) (byEmail[a.email_id] ??= []).push(a);

  const [names, contact] = await Promise.all([
    companyNames([t.company_id, ...(t.match_candidates ?? [])], admin),
    t.contact_id ? admin.from("crm_contacts").select("id, first_name, last_name, email").eq("id", t.contact_id).maybeSingle().then((r: any) => r.data) : null,
  ]);
  if (t.unread && req.nextUrl.searchParams.get("peek") !== "1") await admin.from("crm_email_threads").update({ unread: false }).eq("id", t.id);

  return NextResponse.json({
    thread: {
      ...t, unread: false, mailbox,
      company_name: t.company_id ? names[t.company_id] ?? null : null,
      contact_name: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.email : null,
      assigned_name: t.assigned_staff_id ? staff[t.assigned_staff_id] ?? null : null,
      candidates: (t.match_candidates ?? []).map((id: string) => ({ id, name: names[id] ?? "Company" })),
    },
    emails: list.map((e) => {
      const files = byEmail[e.id] ?? [];
      const cid = Object.fromEntries(files.filter((a) => a.content_id && a.s3_key).map((a) => [a.content_id, `/api/crm/inbox/attachments/${a.id}`]));
      const { body_html, body_text, ...rest } = e;
      return {
        ...rest,
        html: displayEmailHtml(body_html, body_text, cid),
        text: body_text,
        sent_by_name: e.sent_by_staff_id ? staff[e.sent_by_staff_id] ?? null : null,
        attachments: files.filter((a) => !a.is_inline || !a.content_id).map((a) => ({ id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, available: !!a.s3_key })),
      };
    }),
    notes: (notes ?? []).map((n: any) => ({ ...n, author: n.actor_staff_id ? staff[n.actor_staff_id] ?? null : null })),
    staff: Object.entries(staff).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  });
}

/**
 * PATCH /api/crm/inbox/threads/[id] — { status?, assigned_staff_id?, unread?,
 * company_id?, contact_id? }. Linking a company / contact (or clearing it)
 * re-points the thread's timeline entries. A contact implies its company.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { error } = await requireCrmStaff();
  if (error) return error;
  if (!UUID.test(params.id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = await req.json().catch(() => ({}));
  const admin = createAdminSupabaseClient() as any;
  const { data: t } = await admin.from("crm_email_threads").select("id, company_id, contact_id").eq("id", params.id).maybeSingle();
  if (!t) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const patch: Record<string, any> = {};
  if ("status" in b) {
    if (!STATUSES.includes(b.status)) return NextResponse.json({ error: "Bad status" }, { status: 400 });
    patch.status = b.status;
  }
  if ("unread" in b) patch.unread = !!b.unread;
  if ("assigned_staff_id" in b) {
    if (b.assigned_staff_id === null) patch.assigned_staff_id = null;
    else {
      const staff = await staffNames(admin);
      if (typeof b.assigned_staff_id !== "string" || !staff[b.assigned_staff_id]) return NextResponse.json({ error: "Not a DA-CRM team member" }, { status: 400 });
      patch.assigned_staff_id = b.assigned_staff_id;
    }
  }
  let relink = false;
  if ("contact_id" in b || "company_id" in b) {
    let companyId: string | null = "company_id" in b ? (UUID.test(b.company_id ?? "") ? b.company_id : null) : t.company_id;
    let contactId: string | null = "contact_id" in b ? (UUID.test(b.contact_id ?? "") ? b.contact_id : null) : ("company_id" in b && b.company_id !== t.company_id ? null : t.contact_id);
    if (contactId) {
      const { data: c } = await admin.from("crm_contacts").select("company_id").eq("id", contactId).is("deleted_at", null).maybeSingle();
      if (!c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
      if (companyId && companyId !== c.company_id) return NextResponse.json({ error: "Contact isn't at that company" }, { status: 400 });
      companyId = c.company_id;
    }
    if (companyId) {
      const { data: co } = await admin.from("crm_companies").select("id").eq("id", companyId).maybeSingle();
      if (!co) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }
    Object.assign(patch, { company_id: companyId, contact_id: contactId, matched_by: companyId ? "manual" : null, match_candidates: [] });
    relink = true;
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  const { error: upErr } = await admin.from("crm_email_threads").update(patch).eq("id", t.id);
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  if (relink) await relinkThreadActivities(admin, t.id, patch.company_id, patch.contact_id);
  return NextResponse.json({ ok: true });
}
