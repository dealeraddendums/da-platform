import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ownsConversation, setFeedback, escalateConversation, logConversationToHubspot } from "@/lib/help-conversations";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Params = { params: { id: string } };

/** GET — full thread + conversation (owner or super_admin). */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(await ownsConversation(params.id, claims))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: conversation } = await (admin as any).from("help_conversations").select("*").eq("id", params.id).maybeSingle();
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { data: messages } = await (admin as any).from("help_messages").select("id, role, content, feedback, created_at").eq("conversation_id", params.id).order("created_at", { ascending: true });
  return NextResponse.json({ data: { conversation, messages: messages ?? [] } });
}

/**
 * POST — dealer/owner actions on a conversation:
 *   { action: "feedback", messageId, value: "up"|"down" }
 *   { action: "escalate" }   → notify support; returns the dealer-facing message
 *   { action: "close" }      → fire-and-forget HubSpot transcript log
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(await ownsConversation(params.id, claims))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { action?: string; messageId?: string; value?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  switch (body.action) {
    case "feedback": {
      if (!body.messageId || (body.value !== "up" && body.value !== "down")) {
        return NextResponse.json({ error: "messageId + value (up|down) required" }, { status: 400 });
      }
      // confirm the message belongs to this conversation
      const admin = createAdminSupabaseClient();
      const { data: m } = await (admin as any).from("help_messages").select("id, conversation_id").eq("id", body.messageId).maybeSingle();
      if (!m || m.conversation_id !== params.id) return NextResponse.json({ error: "Message not found" }, { status: 404 });
      await setFeedback(body.messageId, body.value);
      return NextResponse.json({ ok: true });
    }
    case "escalate": {
      await escalateConversation(params.id);
      return NextResponse.json({ ok: true, message: "I've notified our team — someone will follow up by email." });
    }
    case "close": {
      void logConversationToHubspot(params.id); // fire-and-forget; never blocks
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}

/** PATCH — super_admin: mark resolved (also logs the transcript to HubSpot). */
export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { status?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (body.status && !["open", "escalated", "resolved"].includes(body.status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const patch: Record<string, unknown> = {};
  if (body.status) patch.status = body.status;
  if (body.status === "resolved") { patch.resolved_at = new Date().toISOString(); patch.resolved_by = claims.sub; }
  const { error: dbErr } = await (admin as any).from("help_conversations").update(patch).eq("id", params.id);
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  if (body.status === "resolved") void logConversationToHubspot(params.id); // fire-and-forget
  return NextResponse.json({ ok: true });
}
