import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { dialpadConfigured, getDialpadCall, isDialpadScopeError, listDialpadCalls } from "@/lib/crm/dialpad";
import { backfillCallMedia, ingestDialpadEvent, type FollowUpResult } from "@/lib/crm/dialpad-ingest";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 600;

/**
 * POST /api/cron/crm-dialpad-reconcile (X-Cron-Secret) — nightly DA-CRM
 * backstop. Pulls every concluded Dialpad call from the last 24h (?hours= to
 * widen, max 168) and feeds each through the same idempotent ingest the
 * webhook uses, so calls the webhook missed appear and partial ones (no
 * recording / transcript / summary yet) fill in.
 *
 * Then a media sweep over our own crm_calls from the last ?days= (default 14,
 * max 90): every call still missing its staff, S3 recording copy, transcript
 * or AI recap gets them fetched — this half doesn't depend on the list call,
 * which needs the key's calls:list scope. Throttled to Dialpad's per-call
 * limits (call info 10/min, ai_recap 12/min), at most 60 calls a run.
 *
 * Fire-and-forget like the other crons: 200 at once, work continues in the
 * background. ?sync=1 runs inline and returns the counts (manual runs).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!dialpadConfigured()) return NextResponse.json({ error: "DIALPAD_API_KEY not set" }, { status: 503 });

  const hours = Math.min(168, Math.max(1, Number(req.nextUrl.searchParams.get("hours")) || 24));
  const days = Math.min(90, Math.max(1, Number(req.nextUrl.searchParams.get("days")) || 14));
  const run = reconcile(hours, days);
  if (req.nextUrl.searchParams.get("sync") === "1") return NextResponse.json(await run);
  run.then(
    (r) => console.log("[crm-dialpad-reconcile]", JSON.stringify(r)),
    (e) => console.error("[crm-dialpad-reconcile] failed:", e instanceof Error ? e.message : e),
  );
  return NextResponse.json({ status: "started", hours, days });
}

const SWEEP_LIMIT = 60;
const SWEEP_GAP_MS = 6_500;   // ≤ 10 Dialpad per-call requests a minute
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reconcile(hours: number, days: number) {
  const before = Date.now();
  const after = before - hours * 3600_000;
  const counts = { seen: 0, created: 0, updated: 0, errors: 0, list_error: null as string | null };
  try {
    for await (const call of listDialpadCalls(after, before)) {
      counts.seen++;
      try {
        const r = await ingestDialpadEvent(call, { source: "reconcile" });
        if (r.status === "ok") {
          if (r.created) counts.created++; else counts.updated++;
          await r.followUp;
        }
      } catch (e) {
        counts.errors++;
        console.error(`[crm-dialpad-reconcile] call ${String(call.call_id)}:`, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    // Most often the key lacks calls:list — the sweep below still runs.
    counts.list_error = isDialpadScopeError(e) ? "API key is missing the calls:list scope" : e instanceof Error ? e.message.slice(0, 300) : String(e);
    console.error("[crm-dialpad-reconcile] list:", counts.list_error);
  }
  return { hours, ...counts, sweep: await sweep(days) };
}

/** Fill staff / recording / transcript / recap on stored calls still missing any. */
async function sweep(days: number) {
  const admin = createAdminSupabaseClient() as any;
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data: calls, error } = await admin.from("crm_calls")
    .select("id, dialpad_call_id, state, duration_sec, staff_id, dialpad_user_id, recording_url, voicemail_url, recording_s3_key, transcript, summary")
    .gte("started_at", since)
    .or("recording_s3_key.is.null,transcript.is.null,summary.is.null,staff_id.is.null")
    .order("started_at", { ascending: false })
    .limit(SWEEP_LIMIT);
  if (error) return { error: error.message };

  const tally: Record<string, number> = {};
  const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
  for (const c of calls ?? []) {
    const finished = (c.state === "completed" && (c.duration_sec ?? 0) > 0) || c.state === "voicemail";
    const needsMedia = finished && !c.recording_s3_key;
    const needsAi = c.state === "completed" && (c.duration_sec ?? 0) > 0 && (!c.transcript || !c.summary);
    if (!needsMedia && !needsAi && (c.staff_id || !c.dialpad_user_id)) continue;
    try {
      // No media URL stored (the hangup event came before the recording) → ask Dialpad for the call.
      const refresh = needsMedia && !c.recording_url && !c.voicemail_url ? await getDialpadCall(c.dialpad_call_id) : undefined;
      const r: FollowUpResult = await backfillCallMedia(admin, c.id, refresh);
      for (const [k, v] of Object.entries(r)) bump(`${k}_${v}`);
    } catch (e) {
      bump("errors");
      console.error(`[crm-dialpad-reconcile] sweep ${c.dialpad_call_id}:`, e instanceof Error ? e.message : e);
    }
    if (needsAi || needsMedia) await sleep(SWEEP_GAP_MS);
  }
  return { checked: (calls ?? []).length, ...tally };
}
