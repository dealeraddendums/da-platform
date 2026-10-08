// Selective ticketing for Steven chats — a PERSON decides which chat becomes a
// ticket (the "Make this a ticket" card in HubSpot, or the super_admin button
// on the Help review screen). Nothing here ever runs automatically.
//
// Tickets are created through the marketing bridge's Tickets API gateway: this
// portal can't create tickets from inbox conversations at all (post-April-2024
// account), and da-platform's own HubSpot token has no tickets scope.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { resolveAsker } from "@/lib/help-conversations";
import { callGateway } from "@/lib/help-handoff";

export interface TicketResult { ok: boolean; ticketId?: string; existing?: boolean; error?: string }

/**
 * Tickets an agent made with the inbox's own "Create ticket" are linked by
 * HubSpot to the conversation THREAD and to the contact — not to the company.
 * Adopt them: record the ticket on the conversation (so "My support tickets"
 * shows it and "Make this a ticket" won't create a second one) and add the
 * dealer's company link. Returns conversationId → ticketId for what it adopted.
 */
export async function adoptInboxTickets(
  convs: { id: string; dealer_id: string | null; hubspot_thread_id: string | null; hubspot_ticket_id: string | null }[],
): Promise<Record<string, string>> {
  const pending = convs.filter((c) => c.hubspot_thread_id && !c.hubspot_ticket_id).slice(0, 25);
  if (!pending.length) return {};
  const r = await callGateway("/api/hubspot-chat/tickets", { action: "from-threads", threadIds: pending.map((c) => c.hubspot_thread_id) });
  const byThread = (r.ok && r.data?.tickets) ? (r.data.tickets as Record<string, string>) : {};
  const a = createAdminSupabaseClient() as any;
  const adopted: Record<string, string> = {};
  for (const c of pending) {
    const ticketId = byThread[c.hubspot_thread_id as string];
    if (!ticketId) continue;
    const { data: upd } = await a.from("help_conversations")
      .update({ hubspot_ticket_id: ticketId, ticketed_at: new Date().toISOString() })
      .eq("id", c.id).is("hubspot_ticket_id", null).select("id");
    if (!upd?.length) continue;
    adopted[c.id] = ticketId;
    if (c.dealer_id) {
      const { data: d } = await a.from("dealers").select("hubspot_company_id").eq("dealer_id", c.dealer_id).maybeSingle();
      if (d?.hubspot_company_id) {
        await callGateway("/api/hubspot-chat/tickets", { action: "link-company", ticketId, companyId: String(d.hubspot_company_id) });
      }
    }
  }
  return adopted;
}

function transcriptText(msgs: { role: string; content: string; sender_name?: string | null; attachments?: { name: string }[]; created_at: string }[]): string {
  return msgs.map((m) => {
    const who = m.role === "assistant" ? "Steven" : m.role === "agent" ? (m.sender_name || "Support") : "Dealer";
    const files = (m.attachments ?? []).map((a) => `[file: ${a.name}]`).join(" ");
    return `${m.created_at.slice(0, 16).replace("T", " ")}  ${who}: ${m.content}${files ? ` ${files}` : ""}`;
  }).join("\n");
}

/**
 * Turn one conversation into a HubSpot ticket, associated to the dealer's
 * contact + company (by the ids DA stores — never by name), with the full
 * transcript as the ticket description. Idempotent: a conversation gets at
 * most one ticket; a repeat call returns the existing one.
 */
export async function makeTicketForConversation(conversationId: string, requestedBy: string): Promise<TicketResult> {
  const admin = createAdminSupabaseClient();
  const a = admin as any;
  const { data: conv } = await a.from("help_conversations")
    .select("id, user_id, dealer_id, group_id, role, context_snapshot, page, hubspot_ticket_id, ticketed_at, hubspot_contact_id, hubspot_thread_id, created_at")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return { ok: false, error: "conversation not found" };
  if (conv.hubspot_ticket_id) return { ok: true, ticketId: conv.hubspot_ticket_id, existing: true };
  // An agent may already have made one with the inbox's own Create ticket.
  const adopted = await adoptInboxTickets([conv]);
  if (adopted[conv.id]) return { ok: true, ticketId: adopted[conv.id], existing: true };

  // Claim the conversation before calling HubSpot, so two clicks at once can't
  // both create a ticket. The loser sees the claim and reports in-progress.
  const { data: claimed } = await a.from("help_conversations")
    .update({ ticketed_at: new Date().toISOString() })
    .eq("id", conversationId).is("ticketed_at", null).is("hubspot_ticket_id", null)
    .select("id");
  if (!claimed?.length) {
    const { data: again } = await a.from("help_conversations").select("hubspot_ticket_id").eq("id", conversationId).maybeSingle();
    return again?.hubspot_ticket_id
      ? { ok: true, ticketId: again.hubspot_ticket_id, existing: true }
      : { ok: false, error: "a ticket for this chat is already being created — refresh in a moment" };
  }

  try {
    const [who, msgsRes, profRes, dealerRes] = await Promise.all([
      resolveAsker(admin, conv),
      a.from("help_messages").select("role, content, sender_name, attachments, created_at")
        .eq("conversation_id", conversationId).order("created_at", { ascending: true }),
      conv.user_id ? a.from("profiles").select("hubspot_contact_id").eq("id", conv.user_id).maybeSingle() : { data: null },
      conv.dealer_id ? a.from("dealers").select("hubspot_company_id").eq("dealer_id", conv.dealer_id).maybeSingle() : { data: null },
    ]);
    const msgs = (msgsRes.data ?? []) as any[];
    const firstAsk = (msgs.find((m) => m.role === "user")?.content || "In-app chat").replace(/\s+/g, " ").trim();
    const contactId = conv.hubspot_contact_id || profRes?.data?.hubspot_contact_id || null;
    const companyId = dealerRes?.data?.hubspot_company_id || null;

    const content = [
      `Created from an in-app Steven chat by ${requestedBy}.`,
      `Who: ${[who.name, who.email, who.role].filter(Boolean).join(" · ") || "unknown"}`,
      `Dealership: ${[who.dealership, conv.dealer_id && `Dealer ID ${conv.dealer_id}`].filter(Boolean).join(" · ") || "none in context"}`,
      who.group ? `Group: ${who.group}` : "",
      conv.page ? `Page: ${conv.page}` : "",
      conv.context_snapshot ? `Account: ${String(conv.context_snapshot).replace(/\n/g, " | ")}` : "",
      "",
      "— Transcript —",
      transcriptText(msgs),
    ].filter(Boolean).join("\n");

    const r = await callGateway("/api/hubspot-chat/tickets", {
      action: "create",
      subject: `${who.dealership ? `${who.dealership}: ` : ""}${firstAsk.slice(0, 120)}`,
      content,
      contactId,
      companyIds: companyId ? [companyId] : [],
    });
    const ticketId = r.ok ? r.data?.ticketId : null;
    if (!ticketId) throw new Error(`gateway HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);

    await a.from("help_conversations").update({ hubspot_ticket_id: String(ticketId) }).eq("id", conversationId);
    return { ok: true, ticketId: String(ticketId) };
  } catch (e) {
    // Release the claim so the person can try again.
    await a.from("help_conversations").update({ ticketed_at: null }).eq("id", conversationId).is("hubspot_ticket_id", null);
    const error = e instanceof Error ? e.message : String(e);
    console.error("[help-tickets] create failed:", error);
    return { ok: false, error };
  }
}

export interface DealerTicket {
  ticketId: string; conversationId: string; subject: string | null; status: string;
  state: "open" | "waiting" | "closed"; updatedAt: string | null; createdAt: string | null;
}

/** Tickets made from this dealership's chats, newest first, with live status. */
export async function ticketsForDealer(dealerId: string): Promise<{ ok: boolean; tickets: DealerTicket[]; error?: string }> {
  const a = createAdminSupabaseClient() as any;
  // Pick up tickets agents made in the inbox since the last look.
  const { data: recent } = await a.from("help_conversations")
    .select("id, dealer_id, hubspot_thread_id, hubspot_ticket_id")
    .eq("dealer_id", dealerId).not("hubspot_thread_id", "is", null).is("hubspot_ticket_id", null)
    .order("updated_at", { ascending: false }).limit(25);
  if (recent?.length) await adoptInboxTickets(recent);

  const { data } = await a.from("help_conversations")
    .select("id, hubspot_ticket_id, ticketed_at")
    .eq("dealer_id", dealerId).not("hubspot_ticket_id", "is", null)
    .order("ticketed_at", { ascending: false }).limit(50);
  const rows = (data ?? []) as { id: string; hubspot_ticket_id: string }[];
  if (!rows.length) return { ok: true, tickets: [] };
  const r = await callGateway("/api/hubspot-chat/tickets", { action: "status", ids: rows.map((x) => x.hubspot_ticket_id) });
  if (!r.ok || !r.data?.ok) return { ok: false, tickets: [], error: "Ticket status is unavailable right now." };
  const byId = new Map<string, any>((r.data.tickets as any[]).map((t) => [String(t.id), t]));
  const tickets = rows.map((x) => {
    const t = byId.get(String(x.hubspot_ticket_id));
    return t ? {
      ticketId: String(x.hubspot_ticket_id), conversationId: x.id, subject: t.subject, status: t.status,
      state: t.state, updatedAt: t.updatedAt, createdAt: t.createdAt,
    } as DealerTicket : null;
  }).filter((t): t is DealerTicket => !!t);
  tickets.sort((p, q) => (q.updatedAt || "").localeCompare(p.updatedAt || ""));
  return { ok: true, tickets };
}
