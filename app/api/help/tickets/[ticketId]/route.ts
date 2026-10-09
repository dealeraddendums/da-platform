import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import { addTicketComment, ticketDetail } from "@/lib/help-ticket-detail";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** GET — one of THIS dealership's support tickets (dealer from the session only):
 *  status + the conversation activity behind it. 404 for anyone else's ticket. */
export async function GET(_req: NextRequest, { params }: { params: { ticketId: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = resolveEffectiveDealer(claims);
  if (!dealerId) return NextResponse.json({ error: "Switch into a dealership to see its tickets." }, { status: 400 });
  const d = await ticketDetail(dealerId, params.ticketId);
  if (!d) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  return NextResponse.json(d);
}

/** POST { text } — add information to the ticket. Posts to the ticket's Support
 *  inbox thread as a customer message. Cannot change status/assignee/close. */
export async function POST(req: NextRequest, { params }: { params: { ticketId: string } }): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = resolveEffectiveDealer(claims);
  if (!dealerId) return NextResponse.json({ error: "Switch into a dealership to add to its tickets." }, { status: 400 });
  const b = await req.json().catch(() => ({})) as { text?: unknown };
  const r = await addTicketComment(claims, dealerId, params.ticketId, typeof b.text === "string" ? b.text : "");
  return NextResponse.json(r.ok ? { ok: true, via: r.via } : { error: r.error }, { status: r.status });
}
