import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ownsConversation, appendMessage, resolveAsker } from "@/lib/help-conversations";
import { storeHelpFile, publishToInbox, ALLOWED_HELP_MIME, MAX_HELP_FILE_BYTES } from "@/lib/help-handoff";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST (multipart: file, body?) — a dealer sends a file while a person has the
 * chat. Stored in the private help-chat bucket, then published into the inbox
 * thread as a HubSpot Files attachment (via the marketing gateway).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(await ownsConversation(params.id, claims))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminSupabaseClient();
  const { data: conv } = await (admin as any).from("help_conversations")
    .select("id, user_id, dealer_id, group_id, role, handoff_provider, live_at").eq("id", params.id).maybeSingle();
  if (!conv || conv.handoff_provider !== "hubspot" || !conv.live_at) {
    return NextResponse.json({ error: "Files can be sent once you're talking to our team." }, { status: 409 });
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "bad form" }, { status: 400 }); }
  const file = form.get("file");
  const caption = String(form.get("body") || "").trim().slice(0, 2000);
  if (!(file instanceof File)) return NextResponse.json({ error: "file required" }, { status: 400 });
  if (file.size > MAX_HELP_FILE_BYTES) return NextResponse.json({ error: "File is too large (10 MB max)." }, { status: 413 });
  if (!ALLOWED_HELP_MIME.has(file.type)) {
    return NextResponse.json({ error: "That file type can't be sent — try an image, PDF, or Office document." }, { status: 415 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let att;
  try { att = await storeHelpFile(conv.id, file.name, file.type, bytes); }
  catch (e) {
    console.error("[help/upload]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Upload failed — please try again." }, { status: 500 });
  }
  const mid = await appendMessage(conv.id, "user", caption, { attachments: [att] });
  const who = await resolveAsker(admin, conv);
  const pub = await publishToInbox({
    conversationId: conv.id, idempotencyId: mid ?? `${conv.id}:${Date.now()}`, who, userId: conv.user_id,
    text: caption || `Sent ${att.name}`, files: [{ name: att.name, mime: att.mime, bytes }],
  });
  return NextResponse.json({ ok: true, relayed: pub.ok, attachment: { name: att.name, mime: att.mime, size: att.size } });
}
