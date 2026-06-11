import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { recordPrint, type PrintRecordPayload } from "@/lib/record-print";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * POST /api/print/confirm — { token }
 *
 * Claims a pending_prints row (stashed by the PDF routes at generation) and
 * runs the print-recording pipeline for its vehicles. Fired by the preview
 * modals on the actual Send-to-Printer / Download action, so cancelled
 * previews never record a print (multiprint-qa-2026-06-11, secondary item).
 *
 * Idempotent: the claim is an atomic DELETE ... RETURNING — a second confirm
 * of the same token (Download then Send, double-click) is a no-op.
 *
 * No print-eligibility gate here: generation was already gated, and blocking
 * a confirm would lose the record of a print that physically happened.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const token = body.token ?? "";
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Authz BEFORE the claim so an unauthorized caller can't destroy the row.
  const { data: row } = await admin
    .from("pending_prints")
    .select("id, dealer_id")
    .eq("id", token)
    .maybeSingle();
  if (!row) return NextResponse.json({ recorded: 0 }); // already claimed / GC'd — no-op

  const authz = await authorizeDealerAction(claims, row.dealer_id);
  if (!authz.ok) return authz.response;

  // Atomic claim — only one confirm gets the payload back.
  const { data: claimed } = await admin
    .from("pending_prints")
    .delete()
    .eq("id", token)
    .select("payload")
    .maybeSingle();
  if (!claimed) return NextResponse.json({ recorded: 0 });

  const payloads = (Array.isArray(claimed.payload) ? claimed.payload : []) as PrintRecordPayload[];
  let recorded = 0;
  for (const p of payloads) {
    try {
      await recordPrint(admin, claims.sub, p);
      recorded++;
    } catch (err) {
      console.error("[print/confirm] recordPrint failed vehicleId=" + p.vehicleId + ":", err instanceof Error ? err.message : err);
    }
  }

  // Opportunistic GC: cancelled previews leave orphan rows — sweep anything
  // older than the TTL so the table never needs a cron.
  void admin
    .from("pending_prints")
    .delete()
    .lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString())
    .then(({ error: gcErr }) => {
      if (gcErr) console.error("[print/confirm] pending GC failed:", gcErr.message);
    });

  return NextResponse.json({ recorded });
}
