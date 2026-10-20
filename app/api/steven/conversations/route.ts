import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { verifyStevenRequest, stevenError, statusOf, type StevenStatus } from "@/lib/steven-dacrm";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUSES: StevenStatus[] = ["human_requested", "agent_active", "closed"];

/**
 * GET ?status=human_requested|agent_active|closed&limit=50&cursor=… — the poll
 * fallback for a missed webhook (steven-dacrm-api.md §5.3). Signed over an empty
 * body. Only conversations that were handed to DA-CRM (dacrm_requested_at), newest
 * hand-off first; cursor = opaque "<dacrm_requested_at>|<id>".
 */
export async function GET(req: Request): Promise<NextResponse> {
  const v = await verifyStevenRequest(req);
  if ("fail" in v) return v.fail;

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") || "human_requested") as StevenStatus;
  if (!STATUSES.includes(status)) return stevenError(400, "bad_request", `status must be one of ${STATUSES.join(", ")}`);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);

  const admin = createAdminSupabaseClient() as any;
  let q = admin.from("help_conversations")
    .select("id, dealer_id, status, escalated_at, agent_engaged_at, dacrm_requested_at")
    .not("dacrm_requested_at", "is", null)
    .order("dacrm_requested_at", { ascending: false }).order("id", { ascending: false })
    .limit(limit + 1);
  if (status === "closed") q = q.eq("status", "resolved");
  else if (status === "human_requested") q = q.eq("status", "escalated").is("agent_engaged_at", null);
  else q = q.eq("status", "escalated").not("agent_engaged_at", "is", null);

  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    let at = "", id = "";
    try { [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|"); } catch { /* bad cursor */ }
    if (!at || !/^[0-9a-f-]{36}$/i.test(id) || isNaN(Date.parse(at))) return stevenError(400, "bad_request", "invalid cursor");
    q = q.or(`dacrm_requested_at.lt."${at}",and(dacrm_requested_at.eq."${at}",id.lt.${id})`);
  }

  const { data, error } = await q;
  if (error) return stevenError(500, "query_failed", error.message);
  const rows = (data ?? []) as any[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? Buffer.from(`${last.dacrm_requested_at}|${last.id}`, "utf8").toString("base64url") : null;

  const dealerIds = Array.from(new Set(page.map((r) => r.dealer_id).filter(Boolean)));
  const { data: dealers } = dealerIds.length
    ? await admin.from("dealers").select("dealer_id, name").in("dealer_id", dealerIds) : { data: [] };
  const names = new Map(((dealers ?? []) as any[]).map((d) => [d.dealer_id, d.name]));
  const previews = await Promise.all(page.map(async (r) => {
    const { data: m } = await admin.from("help_messages").select("content").eq("conversation_id", r.id)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    return ((m?.content as string) ?? "").slice(0, 200);
  }));

  return NextResponse.json({
    conversations: page.map((r, i) => ({
      conversation_id: r.id,
      status: statusOf(r),
      dealer: { name: names.get(r.dealer_id) ?? null, dealer_id: r.dealer_id ?? null },
      last_message_preview: previews[i],
      requested_at: new Date(r.escalated_at ?? r.dacrm_requested_at).toISOString(),
    })),
    next_cursor: nextCursor,
  });
}
