// Send from the DA-CRM Inbox through Microsoft Graph, always AS the mailbox
// (support@ / feeds@), never through Mandrill.
//   reply / replyAll / forward → createReply* on the original message (Outlook
//     fills the quoted history and keeps the conversation) → PATCH our body +
//     recipients → attachments → send
//   new → draft in the chosen mailbox → … → send
// The body always goes through composeEmail() (variables, Outlook-safe HTML,
// the sender's signature). The sent message is fetched back by its immutable
// id and stored at once (lib/crm/inbox-ingest.ts); the Sent Items sync then
// sees the same id and skips it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { composeEmail } from "./email-compose";
import {
  addDraftAttachment, buildDraftPatch, createNewDraft, createReplyDraft, deleteDraft, getMessage, graphUserOf, patchDraft, sendDraft,
  type Recipient, type ReplyMode,
} from "./graph";
import { ingestGraphMessage, MAILBOX_COLS, relinkThreadActivities, type Mailbox } from "./inbox-ingest";
import { normEmail } from "./inbox-match";
import type { TemplateContext } from "./template-vars";

export const OUTBOUND_ATTACHMENT_CAP = 20 * 1024 * 1024;

export type SendInput = {
  staffId: string;
  mode: "new" | ReplyMode;
  emailId?: string | null;          // the message being answered (reply modes)
  mailboxId?: string | null;        // new compose (default: crm_settings.default_compose_mailbox)
  companyId?: string | null;        // new compose from a company / contact record
  contactId?: string | null;
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  bodyHtml: string;
  attachments?: { name: string; contentType: string; bytes: Buffer }[];
  /** Extra template variables for composeEmail (feed orders). */
  templateContext?: TemplateContext;
};

export class SendError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "SendError"; }
}

export function cleanRecipients(list: Recipient[] | undefined): Recipient[] {
  const out: Recipient[] = [];
  for (const r of list ?? []) {
    const email = normEmail(r?.email);
    if (email && !out.some((x) => x.email === email)) out.push({ email, name: r.name ?? null });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendInboxEmail(input: SendInput, admin: any = createAdminSupabaseClient()): Promise<{ emailId: string | null; threadId: string | null }> {
  const to = cleanRecipients(input.to), cc = cleanRecipients(input.cc), bcc = cleanRecipients(input.bcc);
  if (input.mode !== "reply" && input.mode !== "replyAll" && !to.length) throw new SendError(400, "Add at least one recipient");
  const total = (input.attachments ?? []).reduce((n, a) => n + a.bytes.length, 0);
  if (total > OUTBOUND_ATTACHMENT_CAP) throw new SendError(413, "Attachments are over 20 MB");

  // ── Mailbox + the CRM records the variables come from ─────────────────────
  let mailbox: Mailbox | null = null, original: any = null, thread: any = null;
  if (input.mode === "new") {
    let q = admin.from("crm_mailboxes").select(MAILBOX_COLS);
    if (input.mailboxId) q = q.eq("id", input.mailboxId);
    else {
      const { data: s } = await admin.from("crm_settings").select("default_compose_mailbox").eq("id", true).maybeSingle();
      q = q.eq("address", s?.default_compose_mailbox ?? "support@dealeraddendums.com");
    }
    mailbox = (await q.maybeSingle()).data;
  } else {
    if (!input.emailId) throw new SendError(400, "emailId required for a reply");
    original = (await admin.from("crm_emails").select("id, thread_id, mailbox_id, graph_message_id").eq("id", input.emailId).maybeSingle()).data;
    if (!original) throw new SendError(404, "Message not found");
    thread = (await admin.from("crm_email_threads").select("id, company_id, contact_id").eq("id", original.thread_id).maybeSingle()).data;
    mailbox = (await admin.from("crm_mailboxes").select(MAILBOX_COLS).eq("id", original.mailbox_id).maybeSingle()).data;
  }
  if (!mailbox || !mailbox.active) throw new SendError(400, "That mailbox isn't available");

  const companyId = thread?.company_id ?? input.companyId ?? null;
  const contactId = thread?.contact_id ?? input.contactId ?? null;
  const composed = await composeEmail({ subject: input.subject ?? "", bodyHtml: input.bodyHtml ?? "", companyId, contactId, staffId: input.staffId, extraContext: input.templateContext }, admin);
  if (composed.unknown.length) throw new SendError(400, `Fill in or remove: ${composed.unknown.join(", ")}`);

  // ── Draft → patch → attachments → send ─────────────────────────────────────
  const user = graphUserOf(mailbox);
  const draft: any = input.mode === "new" ? await createNewDraft(user) : await createReplyDraft(user, original.graph_message_id, input.mode);
  const fromDraft = (list: any[]): Recipient[] => (list ?? []).map((r: any) => ({ email: r?.emailAddress?.address, name: r?.emailAddress?.name ?? null }));
  const finalTo = to.length ? to : cleanRecipients(fromDraft(draft.toRecipients));
  const finalCc = input.cc ? cc : cleanRecipients(fromDraft(draft.ccRecipients));
  if (!finalTo.length) { await deleteDraft(user, draft.id); throw new SendError(400, "Add at least one recipient"); }
  try {
    await patchDraft(user, draft.id, buildDraftPatch({
      subject: composed.subject || (input.mode === "new" ? "(no subject)" : draft.subject),
      from: { email: mailbox.address, name: mailbox.display_name },
      html: composed.html,
      quotedHtml: input.mode === "new" ? null : draft.body?.content,
      to: finalTo, cc: finalCc, bcc,
    }));
    for (const a of input.attachments ?? []) await addDraftAttachment(user, draft.id, a);
    await sendDraft(user, draft.id);
  } catch (e) {
    await deleteDraft(user, draft.id);
    throw e;
  }

  // ── Store it now (same immutable id the Sent Items sync will see) ─────────
  let sent: any = null;
  for (const wait of [700, 1500, 3000]) {
    await sleep(wait);
    sent = await getMessage(user, draft.id).catch(() => null);
    if (sent && !sent.isDraft) break;
  }
  const msg = sent && !sent.isDraft ? sent : {
    ...draft, isDraft: false, subject: composed.subject || draft.subject,
    body: { contentType: "html", content: composed.html }, receivedDateTime: new Date().toISOString(),
    toRecipients: finalTo.map((r) => ({ emailAddress: { address: r.email, name: r.name } })),
    ccRecipients: finalCc.map((r) => ({ emailAddress: { address: r.email, name: r.name } })),
    from: { emailAddress: { address: mailbox.address, name: mailbox.display_name } },
  };
  const r = await ingestGraphMessage(admin, mailbox, msg, { folder: "sentitems", sentByStaffId: input.staffId });
  const emailId = r.status === "skipped" ? null : r.emailId;
  const threadId = r.status === "skipped" ? null : r.threadId;

  // A new email started from a company / contact record belongs to it.
  if (threadId && input.mode === "new" && (input.companyId || input.contactId)) {
    const { data: t } = await admin.from("crm_email_threads").select("company_id").eq("id", threadId).maybeSingle();
    if (t && !t.company_id) {
      await admin.from("crm_email_threads").update({ company_id: companyId, contact_id: contactId, matched_by: "manual", match_candidates: [] }).eq("id", threadId);
      await relinkThreadActivities(admin, threadId, companyId, contactId);
    }
  }
  if (threadId) await admin.from("crm_email_threads").update({ unread: false }).eq("id", threadId);
  return { emailId, threadId };
}
