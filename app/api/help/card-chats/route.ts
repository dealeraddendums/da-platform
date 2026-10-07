import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

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
 * POST { contactId, email? } — the in-app chats for one HubSpot contact, for the
 * "Make this a ticket" card (via the marketing bridge, X-Webhook-Secret).
 * Matched by the contact id HubSpot resolved on the thread, else the DA user
 * whose profile carries that contact id (or email). Most recent 10.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!secretOk(req.headers.get("x-webhook-secret"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { contactId?: unknown; email?: unknown };
  const contactId = typeof b.contactId === "string" ? b.contactId : "";
  const email = typeof b.email === "string" ? b.email.toLowerCase() : "";
  if (!contactId) return NextResponse.json({ error: "contactId required" }, { status: 400 });

  const a = createAdminSupabaseClient() as any;
  const ors = [`hubspot_contact_id.eq.${contactId}`];
  if (email) ors.push(`email.ilike.${email.replace(/[%_,()]/g, "")}`);
  const { data: profs } = await a.from("profiles").select("id").or(ors.join(",")).limit(10);
  const userIds = ((profs ?? []) as { id: string }[]).map((p) => p.id);

  const convOrs = [`hubspot_contact_id.eq.${contactId}`, ...(userIds.length ? [`user_id.in.(${userIds.join(",")})`] : [])];
  const { data: convs } = await a.from("help_conversations")
    .select("id, dealer_id, status, handoff_provider, hubspot_ticket_id, created_at, updated_at")
    .or(convOrs.join(",")).order("updated_at", { ascending: false }).limit(10);
  const rows = (convs ?? []) as any[];
  if (!rows.length) return NextResponse.json({ chats: [] });

  const ids = rows.map((r) => r.id);
  const dealerIds = rows.map((r) => r.dealer_id).filter((v: string | null, i: number, s: (string | null)[]) => v && s.indexOf(v) === i);
  const [{ data: firsts }, { data: dealers }] = await Promise.all([
    a.from("help_messages").select("conversation_id, content, created_at").in("conversation_id", ids).eq("role", "user").order("created_at", { ascending: true }),
    dealerIds.length ? a.from("dealers").select("dealer_id, name").in("dealer_id", dealerIds) : { data: [] },
  ]);
  const firstBy = new Map<string, string>();
  for (const m of (firsts ?? []) as any[]) if (!firstBy.has(m.conversation_id)) firstBy.set(m.conversation_id, m.content);
  const nameBy = new Map<string, string>(((dealers ?? []) as any[]).map((d) => [d.dealer_id, d.name]));

  return NextResponse.json({
    chats: rows.map((r) => ({
      surface: "inapp",
      id: r.id,
      startedAt: r.created_at,
      updatedAt: r.updated_at,
      preview: (firstBy.get(r.id) || "(no messages)").replace(/\s+/g, " ").slice(0, 140),
      dealership: r.dealer_id ? nameBy.get(r.dealer_id) ?? r.dealer_id : null,
      handedOff: !!r.handoff_provider,
      ticketId: r.hubspot_ticket_id,
    })),
  });
}
