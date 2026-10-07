import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import { ticketsForDealer } from "@/lib/help-tickets";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** GET — "My support tickets": tickets made from this dealership's Steven chats
 *  (dealer resolved from the session only), with their live HubSpot status. */
export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const dealerId = resolveEffectiveDealer(claims);
  if (!dealerId) return NextResponse.json({ ok: true, tickets: [], note: "Switch into a dealership to see its tickets." });
  return NextResponse.json(await ticketsForDealer(dealerId));
}
