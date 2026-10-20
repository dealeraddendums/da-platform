import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { logConversationToHubspot } from "@/lib/help-conversations";
import { verifyStevenRequest, parseJson, stevenError, isUuid } from "@/lib/steven-dacrm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST — DA-CRM resolved the conversation (steven-dacrm-api.md §5.4).
 * Body: { resolved_by?, note?, ts? }. Idempotent. The bubble drops back to
 * Steven on its next poll; the transcript is logged to HubSpot as on any resolve.
 */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const v = await verifyStevenRequest(req);
  if ("fail" in v) return v.fail;
  const p = parseJson(v.raw);
  if (!p.ok) return p.fail;
  if (!isUuid(params.id)) return stevenError(404, "not_found", "conversation not found");

  const admin = createAdminSupabaseClient() as any;
  const { data: conv } = await admin.from("help_conversations").select("id, status").eq("id", params.id).maybeSingle();
  if (!conv) return stevenError(404, "not_found", "conversation not found");

  if (conv.status !== "resolved") {
    const by = typeof p.body.resolved_by === "string" ? p.body.resolved_by.slice(0, 120) : "DA-CRM";
    await admin.from("help_conversations").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", params.id);
    console.log(`[steven-dacrm] ${params.id} closed by ${by}${typeof p.body.note === "string" ? ` — ${p.body.note.slice(0, 300)}` : ""}`);
    void logConversationToHubspot(params.id);
  }
  return NextResponse.json({ ok: true, status: "closed" });
}
