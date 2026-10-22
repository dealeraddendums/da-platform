// Dialpad call event → crm_activities + crm_calls (DA-CRM Phase 1).
//
// One code path for every source: the signed webhook, the nightly reconcile
// (GET /api/v2/call items fed through as if they were events) and the replay
// script. Idempotent on dialpad_call_id — the activity is keyed by
// external_id 'dialpad:{call_id}', the call by its unique dialpad_call_id, and
// both are created with insert-then-reselect so concurrent events for a new
// call can't double-create.
//
// Dialpad delivers events out of order, so every field only ever FILLS (never
// clears) and the call state only moves forward:
//   ringing → connected → missed → completed → voicemail
// (a voicemail outranks everything: once a caller left one, that's the call).
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";
import { matchPhone, supabaseMatchLookup, type PhoneMatch } from "./matching";
import { normalizePhone, formatPhone } from "./phone";
import { formatDuration } from "./format";
import { dialpadConfigured, fetchDialpadAiRecap, fetchDialpadTranscript, isDialpadScopeError } from "./dialpad";
import { copyRecordingToS3, recordingCopyEnabled } from "./recordings";

export type CallState = "ringing" | "connected" | "voicemail" | "missed" | "completed";
export type DialpadCallEvent = Record<string, any>;
export type IngestSource = "webhook" | "reconcile" | "replay";

const RANK: Record<CallState, number> = { ringing: 0, connected: 1, missed: 2, completed: 3, voicemail: 4 };

type CallRow = {
  id: string;
  activity_id: string;
  dialpad_call_id: string;
  company_id: string | null;
  contact_id: string | null;
  staff_id: string | null;
  dialpad_user_id: string | null;
  direction: "inbound" | "outbound";
  from_number: string | null;
  to_number: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  state: CallState;
  recording_url: string | null;
  recording_s3_key: string | null;
  voicemail_url: string | null;
  transcript: string | null;
  summary: string | null;
  last_event_at: string | null;
  raw: Record<string, unknown>;
};

// ── Pure helpers (unit-tested in scripts/crm-verify-unit.ts) ────────────────

/** Dialpad unix-ms (number or numeric string) → ISO; seconds tolerated. */
export function msToIso(v: unknown): string | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

/** The call state this one event implies, or null when it says nothing about state. */
export function eventCallState(ev: DialpadCallEvent): CallState | null {
  const s = String(ev.state ?? "").toLowerCase();
  switch (s) {
    case "preanswer": case "calling": case "ringing": case "queued":
      return "ringing";
    case "connected": case "merged": case "hold": case "parked": case "takeover": case "barge": case "monitor":
      return "connected";
    case "voicemail": case "voicemail_uploaded":
      return "voicemail";
    case "missed":
      return "missed";
    case "hangup": case "postcall": case "blocked":
      if (ev.voicemail_link || (ev.recording_details ?? []).some((r: any) => r?.recording_type === "voicemail")) return "voicemail";
      return ev.date_connected ? "completed" : "missed";
    default:
      // recording / transcription / recap_* / ai_playbook / csat … — but a
      // reconcile item (state "hangup"-less CallProto) still carries dates.
      if (ev.date_ended) return ev.date_connected ? "completed" : "missed";
      return null;
  }
}

export function mergeState(prev: CallState | null, next: CallState | null): CallState {
  if (!prev) return next ?? "ringing";
  if (!next) return prev;
  return RANK[next] > RANK[prev] ? next : prev;
}

export function pickRecordingUrl(ev: DialpadCallEvent): string | null {
  const det = Array.isArray(ev.recording_details) ? ev.recording_details : [];
  const rec = det.find((r: any) => r?.url && r.recording_type !== "voicemail");
  if (rec) return String(rec.url);
  if (Array.isArray(ev.recording_url) && ev.recording_url[0]) return String(ev.recording_url[0]);
  if (typeof ev.recording_url === "string" && ev.recording_url) return ev.recording_url;
  // GET /api/v2/call/{id} and admin_recording events list company auto-recordings here.
  if (Array.isArray(ev.admin_recording_urls) && ev.admin_recording_urls[0]) return String(ev.admin_recording_urls[0]);
  return null;
}

export function pickVoicemailUrl(ev: DialpadCallEvent): string | null {
  const det = Array.isArray(ev.recording_details) ? ev.recording_details : [];
  const vm = det.find((r: any) => r?.url && r.recording_type === "voicemail");
  if (vm) return String(vm.url);
  // On the `voicemail` state the link may still 404 (recording in progress);
  // it's the same URL once `voicemail_uploaded` fires, so keep it either way.
  return typeof ev.voicemail_link === "string" && ev.voicemail_link ? ev.voicemail_link : null;
}

/** AI recap → summary text (summary, then outcome / action items when present). */
export function buildSummary(ev: DialpadCallEvent): string | null {
  const parts: string[] = [];
  if (typeof ev.recap_summary === "string" && ev.recap_summary.trim()) parts.push(ev.recap_summary.trim());
  if (typeof ev.recap_outcome === "string" && ev.recap_outcome.trim()) parts.push(`Outcome: ${ev.recap_outcome.trim()}`);
  const items = Array.isArray(ev.recap_action_items) ? ev.recap_action_items.filter((x: unknown) => typeof x === "string" && x.trim()) : [];
  if (items.length) parts.push(`Action items:\n${items.map((x: string) => `- ${x.trim()}`).join("\n")}`);
  return parts.length ? parts.join("\n\n") : null;
}

const RECAP_FIELDS = ["recap_summary", "recap_outcome", "recap_action_items"] as const;

/**
 * The recap so far: each recap_* event carries only its own field, so merge
 * this event with the earlier ones (raw[state]) and the API recap (raw.ai_recap)
 * — otherwise a later recap_outcome would replace the summary.
 */
export function mergedRecap(raw: Record<string, any> | null | undefined, ev: DialpadCallEvent): DialpadCallEvent {
  const out: DialpadCallEvent = {};
  for (const f of RECAP_FIELDS) {
    const v = ev[f] ?? raw?.[f]?.[f] ?? raw?.ai_recap?.[f];
    if (v != null) out[f] = v;
  }
  return out;
}

export function callDirection(ev: DialpadCallEvent): "inbound" | "outbound" {
  return String(ev.direction ?? "").toLowerCase() === "outbound" ? "outbound" : "inbound";
}

/** Fields to write for this event given the stored row (null = new call). */
export function buildCallPatch(existing: Partial<CallRow> | null, ev: DialpadCallEvent): Partial<CallRow> {
  const dir = existing?.direction ?? callDirection(ev);
  const external = normalizePhone(ev.external_number) ?? (ev.external_number ? String(ev.external_number) : null);
  const internal = normalizePhone(ev.internal_number) ?? (ev.internal_number ? String(ev.internal_number) : null);
  const state = mergeState(existing?.state ?? null, eventCallState(ev));
  const started = existing?.started_at ?? msToIso(ev.date_started);
  const answered = existing?.answered_at ?? msToIso(ev.date_connected);
  const ended = existing?.ended_at ?? msToIso(ev.date_ended);

  let duration = existing?.duration_sec ?? null;
  const evMs = typeof ev.duration === "number" ? ev.duration : Number(ev.duration);
  if (Number.isFinite(evMs) && evMs > 0) duration = Math.max(duration ?? 0, Math.round(evMs / 1000));
  else if (duration == null && answered && ended) duration = Math.max(0, Math.round((Date.parse(ended) - Date.parse(answered)) / 1000));

  const evAt = msToIso(ev.event_timestamp);
  const lastEventAt = [existing?.last_event_at ?? null, evAt].filter(Boolean).sort().pop() ?? null;

  const stateKey = String(ev.state ?? "unknown").toLowerCase() || "unknown";
  const voicemailTranscript = stateKey === "transcription" && typeof ev.transcription_text === "string" && ev.transcription_text.trim()
    ? ev.transcription_text.trim() : null;

  return {
    direction: dir,
    from_number: existing?.from_number ?? (dir === "inbound" ? external : internal),
    to_number: existing?.to_number ?? (dir === "inbound" ? internal : external),
    started_at: started,
    answered_at: answered,
    ended_at: ended,
    duration_sec: duration,
    state,
    recording_url: pickRecordingUrl(ev) ?? existing?.recording_url ?? null,
    voicemail_url: pickVoicemailUrl(ev) ?? existing?.voicemail_url ?? null,
    transcript: existing?.transcript ?? voicemailTranscript,
    summary: buildSummary(mergedRecap(existing?.raw, ev)) ?? existing?.summary ?? null,
    last_event_at: lastEventAt,
    raw: { ...(existing?.raw ?? {}), [stateKey]: ev },
  };
}

const STATE_LABEL: Record<CallState, string> = {
  ringing: "ringing", connected: "in progress", voicemail: "voicemail", missed: "missed", completed: "completed",
};

/** Timeline subject, e.g. "Inbound call from (801) 415-9435 — completed (4m 12s)". */
export function callSubject(c: Pick<CallRow, "direction" | "state" | "from_number" | "to_number" | "duration_sec">): string {
  const other = c.direction === "inbound" ? c.from_number : c.to_number;
  const who = other ? `${c.direction === "inbound" ? " from" : " to"} ${formatPhone(other)}` : "";
  const dur = c.state === "completed" && c.duration_sec ? ` (${formatDuration(c.duration_sec)})` : "";
  return `${c.direction === "inbound" ? "Inbound" : "Outbound"} call${who} — ${STATE_LABEL[c.state]}${dur}`;
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export type IngestResult =
  | { status: "ignored"; reason: string }
  | { status: "duplicate"; dialpadCallId: string }
  | { status: "ok"; dialpadCallId: string; callId: string; created: boolean; followUp: Promise<FollowUpResult> };

async function staffForDialpadUser(admin: any, ev: DialpadCallEvent): Promise<{ staffId: string | null; dialpadUserId: string | null }> {
  const t = ev.target;
  const dialpadUserId = t && String(t.type ?? "").toLowerCase() === "user" && t.id != null ? String(t.id) : null;
  if (!dialpadUserId) return { staffId: null, dialpadUserId: null };
  const { data } = await admin.from("crm_staff_profiles").select("staff_id").eq("dialpad_user_id", dialpadUserId).maybeSingle();
  return { staffId: data?.staff_id ?? null, dialpadUserId };
}

async function findOrCreateActivity(admin: any, dialpadCallId: string, row: Record<string, unknown>): Promise<string> {
  const externalId = `dialpad:${dialpadCallId}`;
  const ins = await admin.from("crm_activities").insert({ ...row, type: "call", external_id: externalId }).select("id").single();
  if (!ins.error) return ins.data.id;
  if (ins.error.code !== "23505") throw new Error(`crm_activities insert: ${ins.error.message}`);
  const { data, error } = await admin.from("crm_activities").select("id").eq("type", "call").eq("external_id", externalId).single();
  if (error) throw new Error(`crm_activities reselect: ${error.message}`);
  return data.id;
}

/**
 * Apply one Dialpad call event. `followUp` (transcript fetch + recording copy)
 * is returned un-awaited so the webhook can ack fast; reconcile awaits it.
 */
export async function ingestDialpadEvent(
  ev: DialpadCallEvent,
  opts: { source: IngestSource; admin?: any } = { source: "webhook" },
): Promise<IngestResult> {
  const admin = opts.admin ?? createAdminSupabaseClient();
  if (ev.call_id == null || ev.call_id === "") return { status: "ignored", reason: "no call_id (not a call event)" };
  const dialpadCallId = String(ev.call_id);
  const stateKey = String(ev.state ?? (opts.source === "reconcile" ? "reconcile" : "unknown")).toLowerCase();

  // Raw log first. An exact redelivery from Dialpad is acknowledged and skipped;
  // reconcile/replay always re-apply (it's idempotent anyway).
  const evTs = Number(ev.event_timestamp);
  const log = await admin.from("crm_dialpad_events").insert({
    source: opts.source,
    dialpad_call_id: dialpadCallId,
    state: stateKey,
    event_timestamp: Number.isFinite(evTs) && evTs > 0 ? Math.round(evTs) : null,
    payload: ev,
  }).select("id").single();
  if (log.error?.code === "23505" && opts.source === "webhook") return { status: "duplicate", dialpadCallId };
  if (log.error && log.error.code !== "23505") console.error("[crm-dialpad] event log insert:", log.error.message);
  const logId: string | null = log.data?.id ?? null;

  try {
    const { data: existing, error: selErr } = await admin.from("crm_calls").select("*").eq("dialpad_call_id", dialpadCallId).maybeSingle();
    if (selErr) throw new Error(`crm_calls select: ${selErr.message}`);

    let call: CallRow;
    let created = false;
    if (existing) {
      call = existing as CallRow;
    } else {
      const direction = callDirection(ev);
      const [match, staff] = await Promise.all([
        matchPhone(ev.external_number, supabaseMatchLookup(admin)).catch((e): PhoneMatch => {
          console.error("[crm-dialpad] match failed:", e instanceof Error ? e.message : e);
          return { e164: normalizePhone(ev.external_number), companyId: null, contactId: null, matchedBy: "none", candidates: 0 };
        }),
        staffForDialpadUser(admin, ev),
      ]);
      const seed = buildCallPatch(null, ev);
      const activityId = await findOrCreateActivity(admin, dialpadCallId, {
        company_id: match.companyId,
        contact_id: match.contactId,
        direction,
        subject: callSubject(seed as CallRow),
        occurred_at: seed.started_at ?? new Date().toISOString(),
        actor_staff_id: staff.staffId,
        metadata: { dialpad_call_id: dialpadCallId, match: { by: match.matchedBy, e164: match.e164, candidates: match.candidates } },
      });
      const ins = await admin.from("crm_calls").insert({
        ...seed,
        activity_id: activityId,
        dialpad_call_id: dialpadCallId,
        company_id: match.companyId,
        contact_id: match.contactId,
        staff_id: staff.staffId,
        dialpad_user_id: staff.dialpadUserId,
      }).select("*").single();
      if (ins.error) {
        if (ins.error.code !== "23505") throw new Error(`crm_calls insert: ${ins.error.message}`);
        const again = await admin.from("crm_calls").select("*").eq("dialpad_call_id", dialpadCallId).single();
        if (again.error) throw new Error(`crm_calls reselect: ${again.error.message}`);
        call = again.data as CallRow;
      } else {
        call = ins.data as CallRow;
        created = true;
      }
    }

    if (!created) {
      const patch = buildCallPatch(call, ev);
      if (!call.staff_id) {
        const staff = await staffForDialpadUser(admin, ev);
        if (staff.staffId) { patch.staff_id = staff.staffId; patch.dialpad_user_id = staff.dialpadUserId; }
      }
      const upd = await admin.from("crm_calls").update(patch).eq("id", call.id).select("*").single();
      if (upd.error) throw new Error(`crm_calls update: ${upd.error.message}`);
      call = upd.data as CallRow;
    }

    await syncActivity(admin, call);
    if (logId) await admin.from("crm_dialpad_events").update({ processed_at: new Date().toISOString() }).eq("id", logId);

    const followUp = runFollowUps(admin, call, stateKey, opts.source).catch((e): FollowUpResult => {
      console.error(`[crm-dialpad] follow-up ${dialpadCallId}:`, e instanceof Error ? e.message : e);
      return {};
    });
    return { status: "ok", dialpadCallId, callId: call.id, created, followUp };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (logId) await admin.from("crm_dialpad_events").update({ error: msg.slice(0, 1000) }).eq("id", logId);
    throw e;
  }
}

/** Keep the timeline row in step with the call (subject, summary, metadata). */
async function syncActivity(admin: any, call: CallRow): Promise<void> {
  const { data: act } = await admin.from("crm_activities").select("metadata").eq("id", call.activity_id).maybeSingle();
  const { error } = await admin.from("crm_activities").update({
    subject: callSubject(call),
    body: call.summary,
    ...(call.started_at ? { occurred_at: call.started_at } : {}),
    ...(call.staff_id ? { actor_staff_id: call.staff_id } : {}),
    metadata: {
      ...(act?.metadata ?? {}),
      dialpad_call_id: call.dialpad_call_id,
      call_id: call.id,
      state: call.state,
      duration_sec: call.duration_sec,
      from: call.from_number,
      to: call.to_number,
      has_recording: !!(call.recording_url || call.recording_s3_key || call.voicemail_url),
      has_transcript: !!call.transcript,
    },
  }).eq("id", call.activity_id);
  if (error) console.error("[crm-dialpad] activity sync:", error.message);
}

export type FollowUpResult = {
  recording?: "copied" | "failed" | "none";
  transcript?: "saved" | "none" | "error";
  recap?: "saved" | "none" | "missing_scope" | "error";
  staff?: "attributed";
};

/** Dialpad user → team member, for calls that came in before the mapping existed. */
async function fillStaff(admin: any, call: CallRow): Promise<CallRow> {
  if (call.staff_id || !call.dialpad_user_id) return call;
  const { data: staff } = await admin.from("crm_staff_profiles").select("staff_id").eq("dialpad_user_id", call.dialpad_user_id).maybeSingle();
  if (!staff?.staff_id) return call;
  const { data } = await admin.from("crm_calls").update({ staff_id: staff.staff_id }).eq("id", call.id).select("*").single();
  return (data as CallRow) ?? call;
}

async function runFollowUps(admin: any, call: CallRow, stateKey: string, source: IngestSource): Promise<FollowUpResult> {
  const out: FollowUpResult = {};
  const finished = call.state === "completed" && (call.duration_sec ?? 0) > 0;
  let changed = false;

  const before = call.staff_id;
  call = await fillStaff(admin, call);
  if (call.staff_id !== before) { out.staff = "attributed"; changed = true; }

  // AI transcript: on Dialpad's call_transcription event, or a reconcile pass
  // over a finished call that still has none.
  if (dialpadConfigured() && !call.transcript && (stateKey === "call_transcription" || (source === "reconcile" && finished))) {
    try {
      const transcript = await fetchDialpadTranscript(call.dialpad_call_id);
      out.transcript = transcript ? "saved" : "none";
      if (transcript) {
        const { data } = await admin.from("crm_calls").update({ transcript }).eq("id", call.id).select("*").single();
        if (data) { call = data as CallRow; changed = true; }
      }
    } catch (e) {
      // 404 = no transcript for this call (AI off / too short) — expected.
      const msg = e instanceof Error ? e.message : String(e);
      out.transcript = msg.includes("→ 404") ? "none" : "error";
      if (out.transcript === "error") console.error(`[crm-dialpad] transcript ${call.dialpad_call_id}:`, msg);
    }
  }

  // AI recap: the recap_* events carry it; reconcile asks the API for calls
  // that finished without one (needs the key's ai_recap scope).
  if (dialpadConfigured() && !call.summary && source === "reconcile" && finished) {
    try {
      const recap = await fetchDialpadAiRecap(call.dialpad_call_id);
      out.recap = recap ? "saved" : "none";
      if (recap) {
        const raw = { ...(call.raw ?? {}), ai_recap: recap };
        const summary = buildSummary(mergedRecap(raw, {}));
        const { data } = await admin.from("crm_calls").update({ summary, raw }).eq("id", call.id).select("*").single();
        if (data) { call = data as CallRow; changed = true; }
      }
    } catch (e) {
      out.recap = isDialpadScopeError(e) ? "missing_scope" : (e instanceof Error && e.message.includes("→ 404")) ? "none" : "error";
      if (out.recap === "error") console.error(`[crm-dialpad] recap ${call.dialpad_call_id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (changed) await syncActivity(admin, call);

  // Copy the audio once. Skipped on the bare `voicemail` event (the link 404s
  // until voicemail_uploaded); a failed copy is retried by the next event or
  // the nightly reconcile.
  const media = call.recording_url ?? call.voicemail_url;
  if (!media) out.recording = "none";
  else if (stateKey !== "voicemail" && !call.recording_s3_key && recordingCopyEnabled()) {
    const key = await copyRecordingToS3(admin, call.id, call.company_id, media).catch((e) => {
      console.error(`[crm-recording] ${call.id}:`, e instanceof Error ? e.message : e);
      return null;
    });
    out.recording = key ? "copied" : "failed";
    if (key) await syncActivity(admin, { ...call, recording_s3_key: key });
  }
  return out;
}

/**
 * Reconcile pass for one stored call: staff, transcript, recap and the S3
 * recording copy — whatever is still missing. `refresh` is the call's current
 * Dialpad record (GET /api/v2/call/{id}) when the stored row had no media URL.
 */
export async function backfillCallMedia(admin: any, callId: string, refresh?: DialpadCallEvent): Promise<FollowUpResult> {
  if (refresh) {
    const r = await ingestDialpadEvent(refresh, { source: "reconcile", admin });
    return r.status === "ok" ? r.followUp : {};
  }
  const { data, error } = await admin.from("crm_calls").select("*").eq("id", callId).single();
  if (error) throw new Error(`crm_calls select: ${error.message}`);
  return runFollowUps(admin, data as CallRow, "backfill", "reconcile");
}
