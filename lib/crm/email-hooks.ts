// onInboundEmail — the DA-CRM Inbox's extension point. Every NEW inbound email
// (stored once; duplicates and outbound mail never fire) is dispatched to the
// registered handlers after the email, its participants, attachments and
// timeline activity are saved. Later modules (feeds, tickets, workflows)
// subscribe here instead of editing the sync code:
//
//   // lib/crm/feeds/inbound.ts
//   registerInboundEmailHandler("feeds", handleFeedsReply, { purpose: "feeds" });
//
// and add their module to lib/crm/email-hook-modules.ts so it loads with the
// sync. Handlers run one after another; a throwing handler is logged and the
// rest still run. Handlers must be idempotent on email.id (a re-dispatch after
// a crash is possible).
/* eslint-disable @typescript-eslint/no-explicit-any */

export type InboundEmailEvent = {
  email: {
    id: string;
    thread_id: string;
    mailbox_id: string;
    graph_message_id: string;
    internet_message_id: string | null;
    in_reply_to: string | null;
    from_email: string | null;
    from_name: string | null;
    to: { email: string; name: string | null }[];
    cc: { email: string; name: string | null }[];
    subject: string | null;
    body_text: string | null;
    body_html: string | null;
    received_at: string;
    is_reply_all: boolean;
    has_attachments: boolean;
  };
  thread: { id: string; company_id: string | null; contact_id: string | null; subject: string | null; status: string; internal: boolean; message_count: number };
  mailbox: { id: string; address: string; purpose: "support" | "feeds" };
};

export type InboundEmailHandler = (event: InboundEmailEvent) => Promise<void> | void;

type Registered = { name: string; handler: InboundEmailHandler; purpose?: "support" | "feeds" };

const registry = new Map<string, Registered>();

/** Register (or replace, by name) a handler. `purpose` limits it to one kind of mailbox. */
export function registerInboundEmailHandler(name: string, handler: InboundEmailHandler, opts: { purpose?: "support" | "feeds" } = {}): void {
  registry.set(name, { name, handler, purpose: opts.purpose });
}

export function unregisterInboundEmailHandler(name: string): void {
  registry.delete(name);
}

export function inboundEmailHandlers(): string[] {
  return Array.from(registry.keys());
}

export type DispatchResult = { name: string; ok: boolean; error?: string };

export async function dispatchInboundEmail(event: InboundEmailEvent): Promise<DispatchResult[]> {
  const out: DispatchResult[] = [];
  for (const r of Array.from(registry.values())) {
    if (r.purpose && r.purpose !== event.mailbox.purpose) continue;
    try {
      await r.handler(event);
      out.push({ name: r.name, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[crm-inbox] onInboundEmail handler "${r.name}" failed for email ${event.email.id}:`, msg);
      out.push({ name: r.name, ok: false, error: msg });
    }
  }
  return out;
}
