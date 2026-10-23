import { NextRequest, NextResponse } from "next/server";
import { requireCrmStaff } from "@/lib/crm/access";
import { createAdminSupabaseClient } from "@/lib/db";
import { graphConfigured, GraphError } from "@/lib/crm/graph";
import { OUTBOUND_ATTACHMENT_CAP, SendError, sendInboxEmail } from "@/lib/crm/inbox-send";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/crm/inbox/send — multipart: `payload` (JSON) + `attachments` (files, 20 MB total).
 * payload: { mode: new|reply|replyAll|forward, email_id?, mailbox_id?, company_id?, contact_id?,
 *            to: [{email,name?}], cc?, bcc?, subject, body_html,
 *            also_add?: [email] — recipients to add as contacts of the compose company }
 * Sends through Graph as the mailbox, with the staff member's signature
 * (composeEmail), and returns { email_id, thread_id }.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireCrmStaff();
  if (error) return error;
  if (!graphConfigured()) return NextResponse.json({ error: "Microsoft 365 isn't connected yet" }, { status: 503 });

  const form = await req.formData().catch(() => null);
  let p: any = null;
  try { p = JSON.parse(String(form?.get("payload") ?? "")); } catch { p = null; }
  if (!p || !["new", "reply", "replyAll", "forward"].includes(p.mode)) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const files = (form?.getAll("attachments") ?? []).filter((f): f is File => typeof f !== "string");
  if (files.reduce((n, f) => n + f.size, 0) > OUTBOUND_ATTACHMENT_CAP) return NextResponse.json({ error: "Attachments are over 20 MB" }, { status: 413 });
  const attachments = await Promise.all(files.map(async (f) => ({
    name: (f.name || "attachment").replace(/[\r\n"\\/]+/g, "_").slice(0, 150),
    contentType: f.type || "application/octet-stream",
    bytes: Buffer.from(await f.arrayBuffer()),
  })));
  const list = (x: any) => (Array.isArray(x) ? x.slice(0, 100).map((r: any) => ({ email: String(r?.email ?? ""), name: r?.name ? String(r.name).slice(0, 200) : null })) : []);

  try {
    const r = await sendInboxEmail({
      staffId: claims.sub, mode: p.mode,
      emailId: typeof p.email_id === "string" ? p.email_id : null,
      mailboxId: typeof p.mailbox_id === "string" ? p.mailbox_id : null,
      companyId: typeof p.company_id === "string" ? p.company_id : null,
      contactId: typeof p.contact_id === "string" ? p.contact_id : null,
      to: list(p.to), cc: Array.isArray(p.cc) ? list(p.cc) : undefined, bcc: list(p.bcc),
      subject: typeof p.subject === "string" ? p.subject.slice(0, 500) : "",
      bodyHtml: typeof p.body_html === "string" ? p.body_html.slice(0, 500_000) : "",
      attachments,
      alsoAdd: Array.isArray(p.also_add) ? p.also_add.slice(0, 100).map((e: any) => String(e ?? "")) : [],
    }, createAdminSupabaseClient() as any);
    return NextResponse.json({ ok: true, email_id: r.emailId, thread_id: r.threadId });
  } catch (e) {
    if (e instanceof SendError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof GraphError ? `Microsoft 365: ${e.message}` : e instanceof Error ? e.message : "Send failed";
    console.error("[crm-inbox-send]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
