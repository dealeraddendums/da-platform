import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getJwtClaims } from "@/lib/auth";
import { makeTicketForConversation } from "@/lib/help-tickets";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function secretOk(given: string | null): boolean {
  const want = process.env.MARKETING_WEBHOOK_SECRET;
  if (!want || !given) return false;
  const a = Buffer.from(want), b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POST { conversationId, requestedBy? } — a person chose to make this chat a
 * ticket. Two callers, both explicit human actions:
 *  - the HubSpot "Make this a ticket" card, via the marketing bridge
 *    (X-Webhook-Secret; requestedBy = the HubSpot user's email);
 *  - a super_admin on the Help review screen (session).
 * Idempotent — a second call returns the existing ticket.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let requestedBy: string | null = null;
  const body = await req.json().catch(() => ({})) as { conversationId?: unknown; requestedBy?: unknown };
  if (secretOk(req.headers.get("x-webhook-secret"))) {
    requestedBy = typeof body.requestedBy === "string" && body.requestedBy ? body.requestedBy : "a HubSpot user";
  } else {
    const claims = await getJwtClaims();
    if (claims?.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    requestedBy = claims.email || "a DA super admin";
  }
  if (typeof body.conversationId !== "string") return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  const r = await makeTicketForConversation(body.conversationId, requestedBy);
  return NextResponse.json(r, { status: r.ok ? 200 : 502 });
}
