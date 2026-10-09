import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ownsConversation } from "@/lib/help-conversations";
import { staffPhotosByEmail } from "@/lib/staff-photos";

export const dynamic = "force-dynamic";
// The same URL is polled every 3s with an unchanged cursor until a reply
// arrives — a cached empty answer would hide that reply forever (the bug the
// homepage widget had, da-marketing-os 75f8902).
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET ?after=ISO — agent replies newer than the cursor (owner only). */
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(await ownsConversation(params.id, claims))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const after = req.nextUrl.searchParams.get("after") || "1970-01-01T00:00:00.000Z";
  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any).from("help_messages")
    .select("id, role, content, sender_name, sender_email, attachments, created_at")
    .eq("conversation_id", params.id).eq("role", "agent").gt("created_at", after)
    .order("created_at", { ascending: true }).limit(50);
  const rows = (data ?? []) as { id: string; content: string; sender_name: string | null; sender_email: string | null; attachments: { name: string; mime: string; size: number }[]; created_at: string }[];
  // The agent's staff headshot (takeover header). The email itself never leaves the server.
  // `agent` is re-resolved on EVERY poll from the conversation's latest agent
  // reply, not just on new messages: a photo saved after the agent first
  // replied (Allan, 2026-10-09 — reply 16:22, headshot 16:29) must still show.
  const { data: lastAgent } = await (admin as any).from("help_messages")
    .select("sender_name, sender_email").eq("conversation_id", params.id).eq("role", "agent")
    .not("sender_name", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const photos = await staffPhotosByEmail([...rows.map((m) => m.sender_email), lastAgent?.sender_email]);
  return NextResponse.json({
    messages: rows.map((m) => ({
      id: m.id, body: m.content, sender: m.sender_name, created_at: m.created_at,
      senderPhoto: photos.get((m.sender_email ?? "").trim().toLowerCase()) ?? null,
      attachments: (m.attachments ?? []).map((a, i) => ({
        name: a.name, mime: a.mime, size: a.size,
        url: `/api/help/conversations/${params.id}/file?message=${m.id}&i=${i}`,
      })),
    })),
    at: rows.length ? rows[rows.length - 1].created_at : after,
    agent: lastAgent ? { name: lastAgent.sender_name, photo: photos.get((lastAgent.sender_email ?? "").trim().toLowerCase()) ?? null } : null,
  });
}
