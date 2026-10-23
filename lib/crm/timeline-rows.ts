// DA-CRM activity timeline: what one compact row says (pure — tested in scripts/crm-company-verify-unit.ts).
// Every activity is one line: type chip · title · who · time. Emails of one thread are ONE row
// (crm_timeline_rows, migration 192). "Who" on an email is the message's sender — our staff member when
// we sent it — never the thread contact.

import { latestReplyText } from "./feeds/detect";
import { displaySubject } from "./thread-display";
import { formatPhone } from "./phone";

export type TimelineFilter = "all" | "email" | "calls" | "chat" | "notes" | "work" | "feeds" | "system";
export const TIMELINE_FILTERS: [TimelineFilter, string][] = [
  ["all", "All"], ["email", "Email"], ["calls", "Calls"], ["chat", "Chat"], ["notes", "Notes"], ["work", "Tickets/Tasks"], ["feeds", "Feeds"], ["system", "System"],
];
/** Activity types behind each filter chip (null = every type). */
export const FILTER_TYPES: Record<TimelineFilter, string[] | null> = {
  all: null, email: ["email"], calls: ["call"], chat: ["chat"], notes: ["note"], work: ["task", "ticket"], feeds: ["feed_order"], system: ["status_change"],
};

export type ActivityLike = {
  id: string; type: string; direction: string | null; subject: string | null; body: string | null;
  metadata: Record<string, any> | null; occurred_at: string; actor_staff_id: string | null; contact_id: string | null;
};

export type TimelineRow = {
  id: string;                 // activity id (for a thread: its newest message)
  activityIds: string[];      // every activity this row stands for (anchors for Summary sources)
  type: string;
  direction: string | null;
  occurredAt: string;
  title: string;
  who: string | null;
  preview: string | null;     // emails: the NEW text of the (newest) message, one line
  state?: string | null;      // calls: completed / missed / voicemail …
  callId?: string | null;
  thread?: { id: string; count: number } | null;
};

const PREVIEW = 140;

/** 125 → "2m 5s", 40 → "40s". */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  return m ? `${m}m ${r}s` : `${r}s`;
}

/** One line of text: whitespace collapsed, capped with an ellipsis. */
export function oneLine(text: string | null | undefined, max = PREVIEW): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** The new text of an email body (quotes, banners, wrapped links, signature removed). */
export function emailNewText(body: string | null | undefined): string {
  return latestReplyText(body);
}

/** First few words — the title fallback when a subject cleans down to nothing ("Re:"). */
export function firstWords(text: string | null | undefined, words = 8): string {
  const w = (text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return w.length > words ? `${w.slice(0, words).join(" ")}…` : w.join(" ");
}

/** Who sent an email: our staff member for outbound mail we sent, else the From name / address. */
export function emailSender(a: Pick<ActivityLike, "direction" | "metadata" | "actor_staff_id">, staff: Record<string, string>): string | null {
  if (a.direction === "outbound" && a.actor_staff_id && staff[a.actor_staff_id]) return staff[a.actor_staff_id];
  const m = a.metadata ?? {};
  return (m.from_name && String(m.from_name).trim()) || m.from_email || m.from || null;
}

/** An email's display title: cleaned subject, else the first words of its new text. */
export function emailTitle(subject: string | null | undefined, body: string | null | undefined): string {
  const s = displaySubject(subject);
  if (s && !/^re:?$/i.test(s)) return s;
  return firstWords(emailNewText(body)) || s || "(no subject)";
}

export function buildRow(a: ActivityLike, staff: Record<string, string>, contactNames: Record<string, string>,
  thread?: { id: string; count: number; activityIds: string[] } | null): TimelineRow {
  const staffName = a.actor_staff_id ? staff[a.actor_staff_id] ?? null : null;
  const contact = a.contact_id ? contactNames[a.contact_id] ?? null : null;
  const base = { id: a.id, activityIds: thread?.activityIds ?? [a.id], type: a.type, direction: a.direction, occurredAt: a.occurred_at };
  switch (a.type) {
    case "email": {
      const preview = oneLine(emailNewText(a.body)) || null;
      return { ...base, title: emailTitle(a.subject, a.body), who: emailSender(a, staff), preview, thread: thread ? { id: thread.id, count: thread.count } : null };
    }
    case "call": {
      const m = a.metadata ?? {};
      const inbound = a.direction === "inbound";
      const number = formatPhone((inbound ? m.from : m.to) ?? null);
      const title = [inbound ? "Inbound" : "Outbound", number || null, m.state ?? null, m.duration_sec ? fmtDuration(Number(m.duration_sec)) : null].filter(Boolean).join(" · ")
        || a.subject?.trim() || "Call";
      return { ...base, title, who: staffName, preview: null, state: m.state ?? null, callId: m.call_id ?? null };
    }
    case "note":
      return { ...base, title: oneLine(a.body || a.subject || "Note", 160), who: staffName, preview: null };
    case "chat":
      return { ...base, title: oneLine(a.subject || a.body || "Chat", 160), who: contact ?? staffName, preview: null };
    case "status_change":
      return { ...base, title: oneLine(a.subject || a.body || "Status change", 160), who: staffName ?? "System", preview: null };
    default:
      return { ...base, title: oneLine(a.subject || a.body || a.type, 160), who: staffName ?? contact, preview: null };
  }
}

/** Day group header: Today · Yesterday · Oct 21 (· 2025 when not this year), in the viewer's time zone. */
export function dayLabel(iso: string, now: Date = new Date(), timeZone?: string): string {
  const key = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const d = new Date(iso);
  if (key(d) === key(now)) return "Today";
  if (key(d) === key(new Date(now.getTime() - 86_400_000))) return "Yesterday";
  const sameYear = d.toLocaleDateString("en-US", { year: "numeric", timeZone }) === now.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone });
}
