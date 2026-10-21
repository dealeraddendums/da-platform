import { NextRequest, NextResponse } from "next/server";
import { verifyDialpadJwt } from "@/lib/crm/dialpad";
import { ingestDialpadEvent } from "@/lib/crm/dialpad-ingest";
import { crmEnv } from "@/lib/crm/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * POST /api/crm/dialpad/webhook — Dialpad call events (DA-CRM Phase 1).
 *
 * The webhook is registered in Dialpad WITH a secret (DIALPAD_WEBHOOK_SECRET),
 * so the body is an HS256 JWT; anything that doesn't verify is 401 and never
 * touches the database. No secret configured → 503 (fail closed).
 *
 * Handles every call state (ringing, connected, hangup, voicemail, recording,
 * call_transcription, recap_summary, …) through lib/crm/dialpad-ingest.ts —
 * idempotent on call_id. Acks once the call/activity rows are written; the
 * transcript fetch + recording copy finish in the background.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = crmEnv("DIALPAD_WEBHOOK_SECRET");
  if (!secret) {
    console.error("[crm-dialpad] webhook hit but DIALPAD_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const raw = (await req.text()).trim();
  // Some senders wrap the token as a JSON string literal; accept both forms.
  const token = raw.startsWith('"') ? (() => { try { return String(JSON.parse(raw)); } catch { return raw; } })() : raw;
  const event = verifyDialpadJwt(token, secret);
  if (!event) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  try {
    const r = await ingestDialpadEvent(event, { source: "webhook" });
    return NextResponse.json(r.status === "ok"
      ? { ok: true, call_id: r.dialpadCallId, created: r.created }
      : { ok: true, ...r });
  } catch (e) {
    // 500 → Dialpad retries; the event is already in crm_dialpad_events with the error.
    console.error("[crm-dialpad] ingest failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
  }
}
