// "My support tickets" → open a ticket + add info (2026-10-09).
//
// Scope: the dealer comes from the SESSION (caller passes it); a ticket is
// readable only if it's one of THAT dealer's tickets — the same list
// ticketsForDealer() shows (chat-made tickets + Customer Support tickets on the
// dealer's HubSpot company). Nothing here can change status, reassign or close.
//
// What the dealer sees (2026-10-09, Allan): the STATUS, the agents' progress
// NOTES on the ticket, and the dealer's OWN additions — not the Steven chat
// transcript. Which notes are dealer-visible is decided in ONE place, the
// bridge's dealerVisibleTicketNotes() (da-marketing-os): human-written, newer
// than the ticket, no `[internal]` / `#internal` marker, not a system note.
// The marker is re-checked here so a bridge regression can't leak one.
//
// A dealer's own additions are help_messages tagged external_id
// `ticket-add:{ticketId}:{uuid}` (written by addTicketComment below).
//
// Adding info posts a CUSTOMER MESSAGE into the ticket's Support-inbox thread
// through the in-app custom channel (the bridge app can't write ticket notes —
// no notes scope). A ticket with no chat behind it gets a new in-app
// conversation, linked to the ticket, so later comments + agent replies stay
// together. If the inbox publish fails, support is emailed instead.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ticketsForDealer, type DealerTicket } from "@/lib/help-tickets";
import { appendMessage, createConversation, escalateByEmail, resolveAsker } from "@/lib/help-conversations";
import { callGateway, publishToInbox } from "@/lib/help-handoff";
import { randomUUID } from "crypto";

export interface TicketNote { id: string; at: string; text: string }
export interface TicketAddition { text: string; at: string }

/** Same marker the bridge filters on — kept in step with INTERNAL_NOTE_MARKER there. */
const INTERNAL_NOTE_MARKER = /[[#]\s*internal\b\]?/i;
const ADDITION_TAG = "ticket-add:";

async function findTicket(dealerId: string, ticketId: string): Promise<DealerTicket | null> {
  if (!/^\d+$/.test(ticketId)) return null;
  const r = await ticketsForDealer(dealerId);
  return r.tickets.find((t) => t.ticketId === ticketId) ?? null;
}

export async function ticketDetail(dealerId: string, ticketId: string): Promise<{ ticket: DealerTicket; notes: TicketNote[]; notesUnavailable: boolean; additions: TicketAddition[] } | null> {
  const ticket = await findTicket(dealerId, ticketId);
  if (!ticket) return null;
  const a = createAdminSupabaseClient() as any;
  const [gw, convs] = await Promise.all([
    callGateway("/api/hubspot-chat/tickets", { action: "dealer-notes", ticketId }),
    a.from("help_conversations").select("id").eq("dealer_id", dealerId).eq("hubspot_ticket_id", ticketId),
  ]);
  const notes: TicketNote[] = gw.ok && Array.isArray(gw.data?.notes)
    ? (gw.data.notes as any[])
      .filter((n) => typeof n?.text === "string" && n.text.trim() && !INTERNAL_NOTE_MARKER.test(n.text))
      .map((n) => ({ id: String(n.id), at: String(n.at), text: String(n.text) }))
    : [];
  const ids = ((convs.data ?? []) as { id: string }[]).map((c) => c.id);
  let additions: TicketAddition[] = [];
  if (ids.length) {
    const { data: msgs } = await a.from("help_messages").select("content, created_at")
      .in("conversation_id", ids).eq("role", "user").like("external_id", `${ADDITION_TAG}${ticketId}:%`)
      .order("created_at", { ascending: true }).limit(100);
    additions = ((msgs ?? []) as any[]).filter((m) => (m.content || "").trim()).map((m) => ({ text: m.content, at: m.created_at }));
  }
  return { ticket, notes, notesUnavailable: !gw.ok, additions };
}

export async function addTicketComment(claims: JwtClaims, dealerId: string, ticketId: string, text: string): Promise<{ ok: boolean; status: number; error?: string; via?: "inbox" | "email" }> {
  const body = text.trim().slice(0, 4000);
  if (!body) return { ok: false, status: 400, error: "Write something to add." };
  const ticket = await findTicket(dealerId, ticketId);
  if (!ticket) return { ok: false, status: 404, error: "Ticket not found" };

  const admin = createAdminSupabaseClient();
  const a = admin as any;
  const { data: existing } = await a.from("help_conversations").select("id, user_id, dealer_id, group_id, role, handoff_provider")
    .eq("dealer_id", dealerId).eq("hubspot_ticket_id", ticketId).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  let convId: string | null = existing?.id ?? null;
  const fresh = !existing || existing.handoff_provider !== "hubspot";
  if (!convId) {
    convId = await createConversation(claims, dealerId, `Follow-up on support ticket #${ticketId}`, null);
    if (!convId) return { ok: false, status: 500, error: "Could not save your note — please try again." };
    await a.from("help_conversations").update({ hubspot_ticket_id: ticketId, ticketed_at: new Date().toISOString() }).eq("id", convId);
  }
  const mid = await appendMessage(convId, "user", body, { externalId: `${ADDITION_TAG}${ticketId}:${randomUUID()}` });
  const { data: conv } = await a.from("help_conversations").select("id, user_id, dealer_id, group_id, role").eq("id", convId).maybeSingle();
  const who = await resolveAsker(admin, conv);
  // A brand-new inbox thread needs the context an agent would otherwise lack.
  const text2 = fresh
    ? `Added to support ticket #${ticketId}${ticket.subject ? ` (“${ticket.subject}”)` : ""}:\n\n${body}`
    : `[Ticket #${ticketId}] ${body}`;
  const pub = await publishToInbox({ conversationId: convId, idempotencyId: mid ?? `${convId}:${Date.now()}`, text: text2, who, userId: claims.sub });
  if (pub.ok) {
    if (fresh) {
      const now = new Date().toISOString();
      await a.from("help_conversations").update({ handoff_provider: "hubspot", status: "escalated", escalated_at: now, live_at: now }).eq("id", convId);
    }
    return { ok: true, status: 200, via: "inbox" };
  }
  await escalateByEmail(convId);
  return { ok: true, status: 200, via: "email" };
}
