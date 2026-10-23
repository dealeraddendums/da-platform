// Store one Graph message in the DA-CRM Inbox: thread (per mailbox +
// conversationId), email, participants, attachments (→ S3), a crm_activities
// row for the timeline, then onInboundEmail for new inbound mail.
// Idempotent: graph_message_id (immutable id) is unique, and so is
// (mailbox_id, internet_message_id) — the webhook, the 10-minute delta sync,
// the backfill and a send from DA-CRM can all deliver the same message and it
// lands once. Used by the webhook route, the sync crons, the backfill script
// and lib/crm/inbox-send.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomUUID } from "crypto";
import { createAdminSupabaseClient } from "@/lib/db";
import { getAttachmentBytes, getAttachmentMeta, graphUserOf, listAttachments, type GraphFolder } from "./graph";
import { matchEmailParticipants, supabaseEmailLookup, type InboxRules } from "./inbox-match";
import { baseSubject, isReplyAll, matchOrder, normalizeGraphMessage, participantsOf, priorMessage, skipReason, snippet, type Addr } from "./inbox-message";
import { dispatchInboundEmail, type InboundEmailEvent } from "./email-hooks";
import { putCrmObject } from "./recordings";
import "./email-hook-modules";

export type Mailbox = { id: string; address: string; graph_user_id: string | null; display_name: string; purpose: "support" | "feeds"; active: boolean };
/** crm_mailboxes columns every Mailbox select needs. */
export const MAILBOX_COLS = "id, address, graph_user_id, display_name, purpose, active";

export type InboxContext = { mailboxes: Mailbox[]; rules: InboxRules; loadedAt: number };

const ATTACHMENT_MAX = 30 * 1024 * 1024;
let ctxCache: InboxContext | null = null;

export async function loadInboxContext(admin: any = createAdminSupabaseClient(), fresh = false): Promise<InboxContext> {
  if (!fresh && ctxCache && Date.now() - ctxCache.loadedAt < 60_000) return ctxCache;
  const [{ data: mbs, error }, { data: s }, sup] = await Promise.all([
    admin.from("crm_mailboxes").select(MAILBOX_COLS).order("address"),
    admin.from("crm_settings").select("email_ignore_senders, email_internal_domains").eq("id", true).maybeSingle(),
    // Feed suppliers are never "ignored senders" (a missing table before migration 182 = none).
    admin.from("crm_feed_supplier_settings").select("request_email, cc_emails, domains"),
  ]);
  const keep = (sup?.error ? [] : sup?.data ?? []).flatMap((r: any) => [r.request_email, ...(Array.isArray(r.cc_emails) ? r.cc_emails : []), ...(Array.isArray(r.domains) ? r.domains : [])])
    .filter((x: unknown): x is string => typeof x === "string" && !!x.trim());
  if (error) throw new Error(`crm_mailboxes: ${error.message}`);
  ctxCache = {
    mailboxes: (mbs ?? []) as Mailbox[],
    rules: {
      ownAddresses: (mbs ?? []).map((m: any) => m.address),
      internalDomains: Array.isArray(s?.email_internal_domains) ? s.email_internal_domains : ["dealeraddendums.com"],
      ignoreSenders: Array.isArray(s?.email_ignore_senders) ? s.email_ignore_senders : [],
      keepSenders: Array.from(new Set(keep)),
    },
    loadedAt: Date.now(),
  };
  return ctxCache;
}

export type IngestResult =
  | { status: "stored"; emailId: string; threadId: string; direction: "inbound" | "outbound" }
  | { status: "duplicate"; emailId: string | null; threadId: string | null }
  | { status: "skipped"; reason: string };

const isUnique = (e: any) => e?.code === "23505";
const toJson = (list: Addr[]) => list.map((a) => ({ email: a.email, name: a.name }));

export async function ingestGraphMessage(
  admin: any,
  mailbox: Mailbox,
  msg: any,
  opts: { folder?: GraphFolder; sentByStaffId?: string | null; ctx?: InboxContext } = {},
): Promise<IngestResult> {
  const ctx = opts.ctx ?? await loadInboxContext(admin);

  const { data: existing } = await admin.from("crm_emails").select("id, thread_id, sent_by_staff_id").eq("graph_message_id", msg?.id ?? "").maybeSingle();
  if (existing) {
    await claimSent(admin, existing, opts.sentByStaffId);
    return { status: "duplicate", emailId: existing.id, threadId: existing.thread_id };
  }
  const why = skipReason(msg, mailbox.address, ctx.rules);
  if (why) return { status: "skipped", reason: why };

  const e = normalizeGraphMessage(msg, mailbox.address, opts.folder);
  if (e.internetMessageId) {
    const { data: same } = await admin.from("crm_emails").select("id, thread_id, sent_by_staff_id").eq("mailbox_id", mailbox.id).eq("internet_message_id", e.internetMessageId).maybeSingle();
    if (same) {
      await claimSent(admin, same, opts.sentByStaffId);
      return { status: "duplicate", emailId: same.id, threadId: same.thread_id };
    }
  }

  // ── Thread ────────────────────────────────────────────────────────────────
  let thread = await findThread(admin, mailbox.id, e.conversationId);
  if (!thread) {
    const { error } = await admin.from("crm_email_threads").insert({
      mailbox_id: mailbox.id, graph_conversation_id: e.conversationId, subject: baseSubject(e.subject) || e.subject,
      last_message_at: e.receivedAt, last_direction: e.direction, unread: e.direction === "inbound", status: "open",
    });
    if (error && !isUnique(error)) throw new Error(`crm_email_threads insert: ${error.message}`);
    thread = await findThread(admin, mailbox.id, e.conversationId);
    if (!thread) throw new Error("thread vanished after insert");
  }

  // ── Match (until a company is set, every new message can fill it in) ──────
  const m = await matchEmailParticipants(matchOrder(e), supabaseEmailLookup(admin), ctx.rules);
  const threadPatch: Record<string, any> = {};
  if (!thread.company_id && m.companyId) {
    Object.assign(threadPatch, { company_id: m.companyId, matched_by: m.matchedBy, match_candidates: [] });
    if (!thread.contact_id && m.contactId) threadPatch.contact_id = m.contactId;
  } else if (!thread.company_id && m.candidates.length) {
    threadPatch.match_candidates = Array.from(new Set([...(thread.match_candidates ?? []), ...m.candidates])).slice(0, 10);
  } else if (thread.company_id && !thread.contact_id && m.contactId && m.companyId === thread.company_id) {
    threadPatch.contact_id = m.contactId;
  }
  const companyId: string | null = threadPatch.company_id ?? thread.company_id ?? null;
  const contactId: string | null = threadPatch.contact_id ?? thread.contact_id ?? null;

  // ── Reply-all against the message this one answers ───────────────────────
  const { data: history } = await admin.from("crm_emails").select("internet_message_id, received_at, from_email, to, cc").eq("thread_id", thread.id).order("received_at", { ascending: false }).limit(50);
  const prior = priorMessage((history ?? []) as any[], e.inReplyTo, e.receivedAt);
  const replyAll = isReplyAll(e, prior ? { from: prior.from_email ? { email: prior.from_email, name: null } : null, to: prior.to ?? [], cc: prior.cc ?? [] } : null);

  // ── Email ─────────────────────────────────────────────────────────────────
  const { data: ins, error: insErr } = await admin.from("crm_emails").upsert({
    thread_id: thread.id, mailbox_id: mailbox.id, graph_message_id: e.graphMessageId, internet_message_id: e.internetMessageId,
    in_reply_to: e.inReplyTo, direction: e.direction, from_email: e.from?.email ?? null, from_name: e.from?.name ?? null, sender_email: e.sender?.email ?? null,
    to: toJson(e.to), cc: toJson(e.cc), bcc: toJson(e.bcc), subject: e.subject, body_html: e.bodyHtml, body_text: e.bodyText,
    received_at: e.receivedAt, sent_by_staff_id: opts.sentByStaffId ?? null, is_reply_all: replyAll, has_attachments: e.hasAttachments, raw: e.raw,
  }, { onConflict: "graph_message_id", ignoreDuplicates: true }).select("id");
  if (insErr && !isUnique(insErr)) throw new Error(`crm_emails insert: ${insErr.message}`);
  const emailId: string | undefined = ins?.[0]?.id;
  if (!emailId) return { status: "duplicate", emailId: null, threadId: thread.id };   // lost a race

  const parts = participantsOf(e);
  if (parts.length) {
    const { error } = await admin.from("crm_email_participants").upsert(parts.map((p) => ({ ...p, email_id: emailId, thread_id: thread.id })), { onConflict: "email_id,address,role", ignoreDuplicates: true });
    if (error) console.error(`[crm-inbox] participants ${emailId}: ${error.message}`);
  }

  // ── Timeline ──────────────────────────────────────────────────────────────
  const { data: act, error: actErr } = await admin.from("crm_activities").upsert({
    company_id: companyId, contact_id: contactId, type: "email", direction: e.direction,
    subject: e.subject || "(no subject)", body: snippet(e.bodyText, 2000),
    // Timeline "who" = the message's sender (from / on-behalf-of sender), never the thread contact.
    metadata: { thread_id: thread.id, email_id: emailId, mailbox: mailbox.address, from: e.from?.email ?? null,
      from_name: e.from?.name ?? null, from_email: e.from?.email?.toLowerCase() ?? null, sender_email: e.sender?.email?.toLowerCase() ?? null,
      to: e.to.map((a) => a.email), cc: e.cc.map((a) => a.email), reply_all: replyAll },
    external_id: `graph:${mailbox.address}:${e.internetMessageId ?? e.graphMessageId}`,
    occurred_at: e.receivedAt, actor_staff_id: opts.sentByStaffId ?? null,
  }, { onConflict: "type,external_id" }).select("id").single();
  if (actErr) console.error(`[crm-inbox] activity ${emailId}: ${actErr.message}`);
  else await admin.from("crm_emails").update({ activity_id: act.id }).eq("id", emailId);

  // ── Thread roll-up ────────────────────────────────────────────────────────
  const newer = !thread.last_message_at || e.receivedAt >= thread.last_message_at;
  Object.assign(threadPatch, {
    message_count: (thread.message_count ?? 0) + 1,
    internal: (thread.message_count ?? 0) === 0 ? m.internal : thread.internal && m.internal,
    ...(newer ? { last_message_at: e.receivedAt, last_direction: e.direction, last_from_email: e.from?.email ?? null, last_from_name: e.from?.name ?? null, last_snippet: snippet(e.bodyText, 200) } : {}),
    ...(e.direction === "inbound" && newer ? { unread: true, ...(thread.status !== "open" ? { status: "open" } : {}) } : {}),
  });
  await admin.from("crm_email_threads").update(threadPatch).eq("id", thread.id);
  if (threadPatch.company_id) await relinkThreadActivities(admin, thread.id, threadPatch.company_id, threadPatch.contact_id ?? null);

  if (e.hasAttachments) {
    await saveAttachments(admin, graphUserOf(mailbox), e.graphMessageId, emailId, companyId).catch((err) =>
      console.error(`[crm-inbox] attachments ${emailId}:`, err instanceof Error ? err.message : err));
  }

  if (e.direction === "inbound") {
    const event: InboundEmailEvent = {
      email: {
        id: emailId, thread_id: thread.id, mailbox_id: mailbox.id, graph_message_id: e.graphMessageId,
        internet_message_id: e.internetMessageId, in_reply_to: e.inReplyTo, from_email: e.from?.email ?? null,
        from_name: e.from?.name ?? null, sender_email: e.sender?.email ?? null, to: e.to, cc: e.cc, subject: e.subject, body_text: e.bodyText,
        body_html: e.bodyHtml, received_at: e.receivedAt, is_reply_all: replyAll, has_attachments: e.hasAttachments,
      },
      thread: {
        id: thread.id, company_id: companyId, contact_id: contactId, subject: thread.subject,
        status: threadPatch.status ?? thread.status, internal: threadPatch.internal, message_count: threadPatch.message_count,
      },
      mailbox: { id: mailbox.id, address: mailbox.address, purpose: mailbox.purpose },
    };
    await dispatchInboundEmail(event);
  }
  return { status: "stored", emailId, threadId: thread.id, direction: e.direction };
}

async function findThread(admin: any, mailboxId: string, conversationId: string): Promise<any | null> {
  const { data } = await admin.from("crm_email_threads")
    .select("id, company_id, contact_id, subject, status, last_message_at, message_count, internal, match_candidates")
    .eq("mailbox_id", mailboxId).eq("graph_conversation_id", conversationId).maybeSingle();
  return data ?? null;
}

/** A send from DA-CRM that the Sent Items sync stored first: record who sent it. */
async function claimSent(admin: any, row: { id: string; sent_by_staff_id: string | null }, staffId?: string | null): Promise<void> {
  if (!staffId || row.sent_by_staff_id) return;
  const { data } = await admin.from("crm_emails").update({ sent_by_staff_id: staffId }).eq("id", row.id).is("sent_by_staff_id", null).select("activity_id").maybeSingle();
  if (data?.activity_id) await admin.from("crm_activities").update({ actor_staff_id: staffId }).eq("id", data.activity_id);
}

/** Point every email activity of a thread at its (newly linked) company / contact. */
export async function relinkThreadActivities(admin: any, threadId: string, companyId: string | null, contactId: string | null): Promise<void> {
  const { data: rows } = await admin.from("crm_emails").select("activity_id").eq("thread_id", threadId).not("activity_id", "is", null);
  const ids = (rows ?? []).map((r: any) => r.activity_id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await admin.from("crm_activities").update({ company_id: companyId, contact_id: contactId }).in("id", ids.slice(i, i + 200));
    if (error) console.error(`[crm-inbox] relink ${threadId}: ${error.message}`);
  }
}

export function attachmentKey(companyId: string | null, emailId: string, filename: string): string {
  const safe = (filename || "attachment").replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 150) || "attachment";
  return `crm/${companyId ?? "unmatched"}/email/${emailId}/${safe}`;
}

async function saveAttachments(admin: any, userId: string, graphId: string, emailId: string, companyId: string | null): Promise<void> {
  const list = await listAttachments(userId, graphId);
  const used = new Set<string>();
  for (const a of list) {
    const isFile = /fileAttachment/i.test(a["@odata.type"] ?? "");
    let name: string = a.name || "attachment";
    if (used.has(name.toLowerCase())) name = `${randomUUID().slice(0, 8)}-${name}`;
    used.add(name.toLowerCase());
    let s3Key: string | null = null, contentId: string | null = null;
    if (isFile && (a.size ?? 0) <= ATTACHMENT_MAX) {
      if (a.isInline) contentId = (await getAttachmentMeta(userId, graphId, a.id).catch(() => null))?.contentId ?? null;
      const bytes = await getAttachmentBytes(userId, graphId, a.id);
      s3Key = attachmentKey(companyId, emailId, name);
      await putCrmObject(s3Key, bytes, a.contentType || "application/octet-stream");
    }
    const { error } = await admin.from("crm_email_attachments").insert({
      email_id: emailId, graph_attachment_id: a.id, filename: name, content_type: a.contentType ?? null, size: a.size ?? null,
      is_inline: !!a.isInline, content_id: contentId ? contentId.replace(/^<|>$/g, "") : null, s3_key: s3Key,
    });
    if (error) console.error(`[crm-inbox] attachment row ${emailId}: ${error.message}`);
  }
}
