// Pure Graph-message handling for the DA-CRM Inbox: normalize a Graph message,
// decide whether to skip it, list its participants, and detect reply-all.
// No database or network — scripts/crm-inbox-verify-unit.ts tests all of it.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { isIgnoredSender, isKeptSender, normEmail, type InboxRules } from "./inbox-match";
import { htmlToText } from "./email-html";

export type Addr = { email: string; name: string | null };

export type NormalizedEmail = {
  graphMessageId: string;
  conversationId: string;
  internetMessageId: string | null;
  inReplyTo: string | null;
  direction: "inbound" | "outbound";
  from: Addr | null;
  /** Graph's `sender`, only when it isn't the From address (mail sent on someone's behalf). */
  sender: Addr | null;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  receivedAt: string;
  hasAttachments: boolean;
  raw: Record<string, any>;
};

function addr(r: any): Addr | null {
  const email = normEmail(r?.emailAddress?.address);
  if (!email) return null;
  const name = (r?.emailAddress?.name ?? "").trim();
  return { email, name: name && name.toLowerCase() !== email ? name : null };
}
const addrs = (list: any): Addr[] => (Array.isArray(list) ? list.map(addr).filter((a): a is Addr => !!a) : []);

function header(msg: any, name: string): string | null {
  const h = (msg?.internetMessageHeaders ?? []).find((x: any) => String(x?.name).toLowerCase() === name.toLowerCase());
  return h?.value ? String(h.value).trim() : null;
}

/** Why a message is not stored, or null to store it. */
export function skipReason(msg: any, mailboxAddress: string, rules: Pick<InboxRules, "ignoreSenders" | "keepSenders">): string | null {
  if (!msg || typeof msg.id !== "string") return "no id";
  if (msg.isDraft) return "draft";
  const type = String(msg["@odata.type"] ?? "");
  if (/eventMessage/i.test(type) || msg.meetingMessageType) return "calendar";
  const ct = header(msg, "Content-Type") ?? "";
  if (/text\/calendar/i.test(ct)) return "calendar";
  const from = normEmail(msg.from?.emailAddress?.address);
  // Our own outbound mail is never "automated".
  // Auto-Submitted mail is NOT skipped wholesale: feed suppliers' systems send
  // Feed IDs that way (Phase 2b). The ignore list is the control — and a feed
  // supplier in From OR Sender overrides it (Autosoft writes through
  // noreply@salesforce.com on behalf of dcsconnect@autosoftdms.com).
  const sender = normEmail(msg.sender?.emailAddress?.address);
  if (isKeptSender(from, rules.keepSenders) || isKeptSender(sender, rules.keepSenders)) return null;
  if (from && from !== mailboxAddress.toLowerCase() && isIgnoredSender(from, rules.ignoreSenders)) return "ignored sender";
  return null;
}

/** Graph message → our shape. `folder` tells sent vs received when From is ambiguous. */
export function normalizeGraphMessage(msg: any, mailboxAddress: string, folder?: "inbox" | "sentitems"): NormalizedEmail {
  const from = addr(msg.from) ?? addr(msg.sender);
  const senderRaw = addr(msg.sender);
  const sender = senderRaw && senderRaw.email !== from?.email ? senderRaw : null;
  const self = mailboxAddress.toLowerCase();
  const direction: "inbound" | "outbound" = folder === "sentitems" || from?.email === self ? "outbound" : "inbound";
  const bodyHtml = msg.body?.contentType?.toLowerCase() === "html" ? (msg.body?.content ?? null) : null;
  const bodyText = bodyHtml ? htmlToText(stripHead(bodyHtml)) : (msg.body?.content ?? msg.bodyPreview ?? null);
  const { body: _body, internetMessageHeaders, ...rest } = msg;
  return {
    graphMessageId: msg.id,
    conversationId: msg.conversationId ?? msg.id,
    internetMessageId: msg.internetMessageId ?? null,
    inReplyTo: header(msg, "In-Reply-To"),
    direction,
    from,
    sender,
    to: addrs(msg.toRecipients),
    cc: addrs(msg.ccRecipients),
    bcc: addrs(msg.bccRecipients),
    subject: msg.subject ?? null,
    bodyHtml,
    bodyText: bodyText ? bodyText.slice(0, 100_000) : null,
    receivedAt: msg.receivedDateTime ?? msg.sentDateTime ?? new Date().toISOString(),
    hasAttachments: !!msg.hasAttachments,
    // Keep only the threading headers, not the whole header block.
    raw: { ...rest, headers: { "in-reply-to": header(msg, "In-Reply-To"), references: header(msg, "References"), "auto-submitted": header(msg, "Auto-Submitted") } },
  };
}

function stripHead(html: string): string {
  return html.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
}

export type ParticipantRow = { address: string; name: string | null; role: "from" | "to" | "cc" | "bcc" };

export function participantsOf(e: Pick<NormalizedEmail, "from" | "to" | "cc" | "bcc">): ParticipantRow[] {
  const rows: ParticipantRow[] = [];
  const push = (a: Addr, role: ParticipantRow["role"]) => {
    if (!rows.some((r) => r.address === a.email && r.role === role)) rows.push({ address: a.email, name: a.name, role });
  };
  if (e.from) push(e.from, "from");
  e.to.forEach((a) => push(a, "to"));
  e.cc.forEach((a) => push(a, "cc"));
  e.bcc.forEach((a) => push(a, "bcc"));
  return rows;
}

/** Addresses to match on, most telling first: inbound → sender, To, Cc; outbound → To, Cc. */
export function matchOrder(e: Pick<NormalizedEmail, "direction" | "from" | "to" | "cc">): string[] {
  const list = e.direction === "inbound" ? [e.from?.email, ...e.to.map((a) => a.email), ...e.cc.map((a) => a.email)]
    : [...e.to.map((a) => a.email), ...e.cc.map((a) => a.email)];
  return list.filter((a): a is string => !!a);
}

type Parts = { from: Addr | null; to: Addr[]; cc: Addr[] };

/**
 * Reply-all: this message's recipients (To + Cc) include everyone else on the
 * message it answers (that message's From + To + Cc, minus this sender).
 * When the prior message had only one other person on it, a reply and a
 * reply-all are the same thing — reported as a plain reply (false).
 */
export function isReplyAll(msg: Parts, prior: Parts | null): boolean {
  if (!prior) return false;
  const sender = msg.from?.email ?? null;
  const others = new Set([prior.from?.email, ...prior.to.map((a) => a.email), ...prior.cc.map((a) => a.email)]
    .filter((a): a is string => !!a && a !== sender));
  if (others.size < 2) return false;
  const recipients = new Set([...msg.to, ...msg.cc].map((a) => a.email));
  return Array.from(others).every((a) => recipients.has(a));
}

/** The message this one answers: In-Reply-To match, else the latest earlier message. */
export function priorMessage<T extends { internet_message_id: string | null; received_at: string }>(history: T[], inReplyTo: string | null, receivedAt: string): T | null {
  if (inReplyTo) {
    const hit = history.find((h) => h.internet_message_id === inReplyTo);
    if (hit) return hit;
  }
  const earlier = history.filter((h) => h.received_at < receivedAt).sort((a, b) => b.received_at.localeCompare(a.received_at));
  return earlier[0] ?? null;
}

/** "RE: FW: Subject" → "Subject" (thread titles, search). */
export function baseSubject(s: string | null | undefined): string {
  return (s ?? "").replace(/^\s*((re|fw|fwd|aw|sv|tr)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
}

/** Short plain-text excerpt for the timeline / thread list. */
export function snippet(text: string | null | undefined, max = 280): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
