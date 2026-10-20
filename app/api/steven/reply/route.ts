import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { appendMessage, logConversationToHubspot } from "@/lib/help-conversations";
import { verifyStevenRequest, parseJson, stevenError, isUuid, isPresent, CONV_COLUMNS } from "@/lib/steven-dacrm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST — a DA-CRM agent's message into a Steven conversation (steven-dacrm-api.md §5.1).
 * Body: { conversation_id, message, agent_name?, message_id, ts?, close? }
 * Idempotent on message_id (stored as help_messages.external_id "dacrm:<id>").
 * The bubble picks the reply up on its 3s poll; delivered=false = the dealer
 * isn't in the chat right now, so it waits for them.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const v = await verifyStevenRequest(req);
  if ("fail" in v) return v.fail;
  const p = parseJson(v.raw);
  if (!p.ok) return p.fail;
  const b = p.body;

  const conversationId = typeof b.conversation_id === "string" ? b.conversation_id : "";
  const text = typeof b.message === "string" ? b.message.trim().slice(0, 10_000) : "";
  const messageId = typeof b.message_id === "string" ? b.message_id.trim().slice(0, 200) : "";
  const agentName = typeof b.agent_name === "string" && b.agent_name.trim() ? b.agent_name.trim().slice(0, 120) : null;
  const close = b.close === true;
  if (!conversationId || !messageId || (!text && !close)) {
    return stevenError(400, "bad_request", "conversation_id, message_id and message are required");
  }
  if (!isUuid(conversationId)) return stevenError(404, "not_found", "conversation not found");

  const admin = createAdminSupabaseClient() as any;
  const { data: conv } = await admin.from("help_conversations").select(CONV_COLUMNS).eq("id", conversationId).maybeSingle();
  if (!conv) return stevenError(404, "not_found", "conversation not found");

  const externalId = `dacrm:${messageId}`;
  const existing = async () => (await admin.from("help_messages")
    .select("id, conversation_id, content, created_at").eq("external_id", externalId).maybeSingle()).data;

  // A retry of a reply we already stored → the original result.
  const dup = text ? await existing() : null;
  if (dup) return duplicate(dup, conversationId, text, conv);

  if (conv.status === "resolved") return stevenError(409, "conversation_closed", "conversation is closed");

  if (text) {
    // Not live with anyone yet (bot, or escalated by email): DA-CRM takes it, so
    // the dealer's next message reaches the agent instead of Steven. A
    // HubSpot-live conversation stays HubSpot's; the reply still shows.
    if (!conv.live_at || (conv.handoff_provider !== "hubspot" && conv.handoff_provider !== "dacrm")) {
      const now = new Date().toISOString();
      await admin.from("help_conversations").update({
        handoff_provider: "dacrm", live_at: now, status: "escalated", escalated_at: conv.escalated_at ?? now,
      }).eq("id", conversationId);
    }
    const id = await appendMessage(conversationId, "agent", text, { senderName: agentName, externalId });
    if (!id) {
      const raced = await existing(); // a concurrent retry stored it first
      if (raced) return duplicate(raced, conversationId, text, conv);
      return stevenError(500, "store_failed", "could not store the reply — retry");
    }
  }

  if (close) {
    await admin.from("help_conversations").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", conversationId);
    void logConversationToHubspot(conversationId);
  }
  return NextResponse.json({ ok: true, conversation_id: conversationId, delivered: !!text && isPresent(conv) });
}

function duplicate(dup: any, conversationId: string, text: string, conv: any): NextResponse {
  if (dup.conversation_id !== conversationId || dup.content !== text) {
    return stevenError(409, "idempotency_conflict", "message_id was already used with a different body");
  }
  // Delivered if the bubble has polled since the reply was stored (or is polling now).
  const seenSince = !!conv.last_seen_at && new Date(conv.last_seen_at) >= new Date(dup.created_at);
  return NextResponse.json({ ok: true, conversation_id: conversationId, delivered: seenSince || isPresent(conv), deduped: true });
}
