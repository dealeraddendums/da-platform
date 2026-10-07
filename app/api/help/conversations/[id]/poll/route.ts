import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ownsConversation } from "@/lib/help-conversations";

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
    .select("id, role, content, sender_name, attachments, created_at")
    .eq("conversation_id", params.id).eq("role", "agent").gt("created_at", after)
    .order("created_at", { ascending: true }).limit(50);
  const rows = (data ?? []) as { id: string; content: string; sender_name: string | null; attachments: { name: string; mime: string; size: number }[]; created_at: string }[];
  return NextResponse.json({
    messages: rows.map((m) => ({
      id: m.id, body: m.content, sender: m.sender_name, created_at: m.created_at,
      attachments: (m.attachments ?? []).map((a, i) => ({
        name: a.name, mime: a.mime, size: a.size,
        url: `/api/help/conversations/${params.id}/file?message=${m.id}&i=${i}`,
      })),
    })),
    at: rows.length ? rows[rows.length - 1].created_at : after,
  });
}
