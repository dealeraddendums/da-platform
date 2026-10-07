import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { ownsConversation } from "@/lib/help-conversations";
import { HELP_CHAT_BUCKET } from "@/lib/help-handoff";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET ?message=&i= — redirect to a 5-minute signed URL for one attachment
 *  (owner only). The path comes from the message row, never the query. */
export async function GET(req: NextRequest, { params }: { params: { id: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!(await ownsConversation(params.id, claims))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const message = req.nextUrl.searchParams.get("message") || "";
  const i = Number(req.nextUrl.searchParams.get("i") || "0");
  if (!message || !Number.isInteger(i) || i < 0) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any).from("help_messages").select("attachments")
    .eq("id", message).eq("conversation_id", params.id).maybeSingle();
  const path = (data?.attachments as { path?: string }[] | undefined)?.[i]?.path;
  if (!path) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data: signed } = await admin.storage.from(HELP_CHAT_BUCKET).createSignedUrl(path, 300);
  if (!signed?.signedUrl) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.redirect(signed.signedUrl);
}
