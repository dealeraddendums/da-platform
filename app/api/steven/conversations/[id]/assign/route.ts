import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifyStevenRequest, parseJson, stevenError, isUuid } from "@/lib/steven-dacrm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST — an agent picked the conversation up (steven-dacrm-api.md §5.5).
 * Body: { agent_name }. Re-assigning to the same agent is a no-op; a different
 * agent gets 409 (prevents double pickup) unless { force: true }.
 */
export async function POST(req: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const v = await verifyStevenRequest(req);
  if ("fail" in v) return v.fail;
  const p = parseJson(v.raw);
  if (!p.ok) return p.fail;
  const agent = typeof p.body.agent_name === "string" ? p.body.agent_name.trim().slice(0, 120) : "";
  if (!agent) return stevenError(400, "bad_request", "agent_name is required");
  if (!isUuid(params.id)) return stevenError(404, "not_found", "conversation not found");

  const admin = createAdminSupabaseClient() as any;
  const { data: conv } = await admin.from("help_conversations")
    .select("id, status, assigned_agent, agent_engaged_at").eq("id", params.id).maybeSingle();
  if (!conv) return stevenError(404, "not_found", "conversation not found");
  if (conv.status === "resolved") return stevenError(409, "conversation_closed", "conversation is closed");
  if (conv.assigned_agent && conv.assigned_agent !== agent && p.body.force !== true) {
    return stevenError(409, "already_assigned", `already assigned to ${conv.assigned_agent}`);
  }
  await admin.from("help_conversations").update({
    assigned_agent: agent, agent_engaged_at: conv.agent_engaged_at ?? new Date().toISOString(),
  }).eq("id", params.id);
  return NextResponse.json({ ok: true });
}
