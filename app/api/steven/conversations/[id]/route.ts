import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifyStevenRequest, stevenError, isUuid, statusOf, dealerContext, conversationMessages, CONV_COLUMNS } from "@/lib/steven-dacrm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** GET — full conversation + dealer context + messages (steven-dacrm-api.md §5.2). Signed over an empty body. */
export async function GET(req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const v = await verifyStevenRequest(req);
  if ("fail" in v) return v.fail;
  if (!isUuid(params.id)) return stevenError(404, "not_found", "conversation not found");

  const admin = createAdminSupabaseClient() as any;
  const { data: conv } = await admin.from("help_conversations").select(CONV_COLUMNS).eq("id", params.id).maybeSingle();
  if (!conv) return stevenError(404, "not_found", "conversation not found");

  return NextResponse.json({
    conversation_id: conv.id,
    status: statusOf(conv),
    dealer: await dealerContext(admin, conv),
    messages: await conversationMessages(admin, conv.id),
    assigned_agent: conv.assigned_agent ?? null,
    channel: conv.handoff_provider ?? null,
    created_at: new Date(conv.created_at).toISOString(),
    updated_at: new Date(conv.updated_at).toISOString(),
  });
}
