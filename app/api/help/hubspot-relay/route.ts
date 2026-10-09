import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { appendMessage } from "@/lib/help-conversations";
import { storeHelpFile, type HelpAttachment } from "@/lib/help-handoff";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

function secretOk(given: string | null): boolean {
  const want = process.env.MARKETING_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = Buffer.from(want), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST — an agent replied in the HubSpot Support inbox to an in-app Steven
 * thread. Called ONLY by the marketing bridge (which receives HubSpot's
 * webhook); auth is the shared X-Webhook-Secret. Stores the reply (deduped on
 * the HubSpot message id) for the bubble's poll.
 * Body: { conversationId, messageId, text, senderName?, senderEmail?, hubspotThreadId?,
 *         hubspotContactId?, files?: [{ name, mime, base64 }] }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!secretOk(req.headers.get("x-webhook-secret"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as any;
  if (!b || typeof b.conversationId !== "string" || typeof b.messageId !== "string") {
    return NextResponse.json({ error: "conversationId and messageId required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data: conv } = await (admin as any).from("help_conversations")
    .select("id, hubspot_thread_id, hubspot_contact_id").eq("id", b.conversationId).maybeSingle();
  if (!conv) return NextResponse.json({ error: "unknown conversation" }, { status: 404 });

  const patch: Record<string, string> = {};
  if (b.hubspotThreadId && !conv.hubspot_thread_id) patch.hubspot_thread_id = String(b.hubspotThreadId);
  if (b.hubspotContactId && !conv.hubspot_contact_id) patch.hubspot_contact_id = String(b.hubspotContactId);
  if (Object.keys(patch).length) await (admin as any).from("help_conversations").update(patch).eq("id", conv.id);

  // Already stored (HubSpot retried)? Nothing more to do — and don't re-upload files.
  const { data: dup } = await (admin as any).from("help_messages").select("id").eq("external_id", b.messageId).maybeSingle();
  if (dup) return NextResponse.json({ ok: true, deduped: true });

  const attachments: HelpAttachment[] = [];
  for (const f of (Array.isArray(b.files) ? b.files : []) as { name?: string; mime?: string; base64?: string }[]) {
    if (!f?.base64) continue;
    try { attachments.push(await storeHelpFile(conv.id, f.name || "attachment", f.mime || "application/octet-stream", Buffer.from(f.base64, "base64"))); }
    catch (e) { console.error("[help/hubspot-relay] file store failed:", e instanceof Error ? e.message : e); }
  }
  const text = typeof b.text === "string" ? b.text : "";
  if (!text && !attachments.length) return NextResponse.json({ ok: true, empty: true });
  await appendMessage(conv.id, "agent", text, {
    attachments, senderName: typeof b.senderName === "string" ? b.senderName : null,
    senderEmail: typeof b.senderEmail === "string" ? b.senderEmail.slice(0, 200) : null, externalId: b.messageId,
  });
  return NextResponse.json({ ok: true });
}
