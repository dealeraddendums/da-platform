/* npm run test:crm — DA-CRM Phase 1 pure logic: phone normalization, call →
   company/contact matching, trial-day math, Dialpad webhook JWT + outbound
   webhook signing, Dialpad call-state handling. No database or network. */
import { createHmac } from "crypto";
import { normalizePhone, formatPhone } from "../lib/crm/phone";
import { matchPhone, type MatchLookup } from "../lib/crm/matching";
import { trialStatus, dueMilestones, pacificDate } from "../lib/crm/trial";
import { signDialpadJwt, verifyDialpadJwt, parseDialpadJson, formatTranscript, adminRecordingId, isDialpadScopeError } from "../lib/crm/dialpad";
import { signCrmWebhook, nextAttemptDelayMs } from "../lib/crm/outbound";
import { parseEnvFile } from "../lib/crm/env";
import { buildCallPatch, eventCallState, mergeState, msToIso, pickRecordingUrl, buildSummary, callSubject, mergedRecap } from "../lib/crm/dialpad-ingest";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

async function main() {
  // ── Phone normalization (same cases as public.crm_normalize_phone) ─────────
  const phones: [string | null, string | null][] = [
    ["(801) 415-9435", "+18014159435"],
    ["801.415.9435", "+18014159435"],
    ["801-415-9435 x22", "+18014159435"],
    ["801 415 9435 ext. 4", "+18014159435"],
    ["1-801-415-9435", "+18014159435"],
    ["+1 (801) 415-9435", "+18014159435"],
    ["+18014159435", "+18014159435"],
    ["+44 20 7946 0958", "+442079460958"],
    ["011 44 20 7946 0958", "+442079460958"],
    ["555-1234", null],                 // 7 digits — no area code
    ["(123) 456-7890", null],           // area code can't start with 1
    ["(801) 155-1234", null],           // exchange can't start with 1
    ["+1 801 415 943", null],           // +1 with 10 digits total
    ["", null],
    [null, null],
    ["call me", null],
  ];
  for (const [raw, want] of phones) eq(`normalizePhone(${JSON.stringify(raw)})`, normalizePhone(raw), want);
  eq("formatPhone NANP", formatPhone("+18014159435"), "(801) 415-9435");
  eq("formatPhone intl unchanged", formatPhone("+442079460958"), "+442079460958");

  // ── Matching ───────────────────────────────────────────────────────────────
  const lookup = (contacts: Record<string, { id: string; company_id: string; updated_at: string }[]>, companies: Record<string, { id: string; kind: string; active: boolean }[]>): MatchLookup => ({
    contactsByPhone: async (p) => contacts[p] ?? [],
    companiesByPhone: async (p) => companies[p] ?? [],
  });
  const L = lookup(
    {
      "+18015550100": [
        { id: "c-old", company_id: "co-1", updated_at: "2026-01-01T00:00:00Z" },
        { id: "c-new", company_id: "co-2", updated_at: "2026-09-01T00:00:00Z" },
      ],
    },
    {
      "+18015550199": [
        { id: "co-group", kind: "group", active: true },
        { id: "co-inactive-dealer", kind: "dealer", active: false },
        { id: "co-dealer", kind: "dealer", active: true },
      ],
      "+18015550111": [{ id: "co-vendor", kind: "vendor", active: true }],
    },
  );
  eq("contact match wins, newest contact", await matchPhone("(801) 555-0100", L),
    { e164: "+18015550100", companyId: "co-2", contactId: "c-new", matchedBy: "contact", candidates: 2 });
  eq("company phone: active dealer beats group / inactive", await matchPhone("801.555.0199", L),
    { e164: "+18015550199", companyId: "co-dealer", contactId: null, matchedBy: "company_phone", candidates: 3 });
  eq("company phone: partner", await matchPhone("+1 801 555 0111", L),
    { e164: "+18015550111", companyId: "co-vendor", contactId: null, matchedBy: "company_phone", candidates: 1 });
  eq("no match → unmatched", await matchPhone("(212) 555-0188", L),
    { e164: "+12125550188", companyId: null, contactId: null, matchedBy: "none", candidates: 0 });
  eq("blocked / anonymous caller → unmatched", await matchPhone("anonymous", L),
    { e164: null, companyId: null, contactId: null, matchedBy: "none", candidates: 0 });

  // ── Trial-day math (Pacific calendar days) ─────────────────────────────────
  const start = "2026-10-01T15:00:00Z"; // Oct 1 08:00 PT
  const at = (iso: string) => new Date(iso);
  eq("day 1 on start day", trialStatus(start, at("2026-10-02T06:00:00Z")).trialDay, 1);        // Oct 1 23:00 PT
  eq("day 2 after Pacific midnight", trialStatus(start, at("2026-10-02T08:00:00Z")).trialDay, 2); // Oct 2 01:00 PT
  eq("ends on day 30", trialStatus(start, at("2026-10-10T15:00:00Z")).endsOn, "2026-10-30");
  eq("day 23 → not yet expiring", trialStatus(start, at("2026-10-23T15:00:00Z")).flag, null);
  eq("day 24 → expiring (7 days left incl. today)", trialStatus(start, at("2026-10-24T15:00:00Z")).flag, "expiring");
  eq("last day (30) still expiring, 0 left", [trialStatus(start, at("2026-10-30T15:00:00Z")).trialDay, trialStatus(start, at("2026-10-30T15:00:00Z")).daysLeft, trialStatus(start, at("2026-10-30T15:00:00Z")).flag], [30, 0, "expiring"]);
  eq("day 31 → expired", trialStatus(start, at("2026-10-31T15:00:00Z")).flag, "expired");
  eq("extended trial_ends_at wins", trialStatus(start, at("2026-10-31T15:00:00Z"), "2026-11-13T12:00:00Z").flag, null);
  eq("shorter override ignored", trialStatus(start, at("2026-10-10T15:00:00Z"), "2026-10-05T12:00:00Z").endsOn, "2026-10-30");
  eq("DST: Nov 2 is still one day after Nov 1", trialStatus("2026-11-01T15:00:00Z", at("2026-11-02T20:00:00Z")).trialDay, 2);
  eq("milestone on day 7", dueMilestones(start, trialStatus(start, at("2026-10-07T15:00:00Z")), at("2026-10-07T15:00:00Z")), [7]);
  eq("milestone grace (day 9 still writes 7)", dueMilestones(start, trialStatus(start, at("2026-10-09T15:00:00Z")), at("2026-10-09T15:00:00Z")), [7]);
  eq("past grace (day 11) writes nothing", dueMilestones(start, trialStatus(start, at("2026-10-11T15:00:00Z")), at("2026-10-11T15:00:00Z")), []);
  eq("expiry milestone the day after the last day", dueMilestones(start, trialStatus(start, at("2026-10-31T15:00:00Z")), at("2026-10-31T15:00:00Z")), ["expired"]);
  const ancient = "2024-01-01T15:00:00Z";
  eq("years-old back-filled trial writes no milestones", dueMilestones(ancient, trialStatus(ancient, at("2026-10-20T15:00:00Z")), at("2026-10-20T15:00:00Z")), []);
  eq("pacificDate", pacificDate("2026-10-02T06:59:00Z"), "2026-10-01");

  // ── Webhook signing ────────────────────────────────────────────────────────
  const secret = "test-secret-123";
  const payload = { call_id: 5747322335264768, state: "hangup", direction: "inbound" };
  const jwt = signDialpadJwt(payload, secret);
  eq("Dialpad JWT round-trips", verifyDialpadJwt(jwt, secret), { call_id: "5747322335264768", state: "hangup", direction: "inbound" });
  eq("wrong secret rejected", verifyDialpadJwt(jwt, "other"), null);
  const [h, p, s] = jwt.split(".");
  const tampered = Buffer.from(JSON.stringify({ ...payload, state: "connected" })).toString("base64url");
  eq("tampered payload rejected", verifyDialpadJwt(`${h}.${tampered}.${s}`, secret), null);
  const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  eq("alg:none rejected", verifyDialpadJwt(`${noneHeader}.${p}.`, secret), null);
  eq("plain JSON rejected", verifyDialpadJwt(JSON.stringify(payload), secret), null);
  eq("expired JWT rejected", verifyDialpadJwt(signDialpadJwt({ ...payload, exp: 1 }, secret), secret), null);
  eq("empty secret never verifies", verifyDialpadJwt(jwt, ""), null);
  eq("int64 ids kept exact", (parseDialpadJson('{"call_id": 12345678901234567890, "date_started": 1582853645285}') as Record<string, unknown>),
    { call_id: "12345678901234567890", date_started: 1582853645285 });

  const body = '{"id":"e1","event":"company.stage_changed"}';
  eq("outbound signature = sha256 HMAC(ts.body)", signCrmWebhook("1700000000", body, secret),
    `sha256=${createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex")}`);
  eq("backoff schedule", [1, 2, 3, 7, 8].map((n) => nextAttemptDelayMs(n) / 60_000), [1, 5, 15, 720, 720]);

  // ── Dialpad call-state handling ────────────────────────────────────────────
  eq("ringing", eventCallState({ state: "ringing" }), "ringing");
  eq("hangup connected → completed", eventCallState({ state: "hangup", date_connected: 1 }), "completed");
  eq("hangup unanswered → missed", eventCallState({ state: "hangup", date_connected: null }), "missed");
  eq("hangup with voicemail → voicemail", eventCallState({ state: "hangup", voicemail_link: "https://x" }), "voicemail");
  eq("recording event says nothing about state", eventCallState({ state: "recording" }), null);
  eq("reconcile CallProto with dates", eventCallState({ date_ended: 2, date_connected: 1 }), "completed");
  eq("state never regresses", mergeState("completed", "connected"), "completed");
  eq("voicemail beats missed", mergeState("missed", "voicemail"), "voicemail");
  eq("ms → ISO", msToIso(1582853645285), "2020-02-28T01:34:05.285Z");
  eq("seconds tolerated", msToIso(1582853645), "2020-02-28T01:34:05.000Z");
  eq("recording_details preferred, voicemail skipped", pickRecordingUrl({
    recording_details: [{ url: "https://vm", recording_type: "voicemail" }, { url: "https://rec", recording_type: "callrecording" }],
  }), "https://rec");
  eq("legacy recording_url list", pickRecordingUrl({ recording_url: ["https://a"] }), "https://a");
  eq("recap summary", buildSummary({ recap_summary: "Feed reset.", recap_action_items: ["Check tomorrow"] }), "Feed reset.\n\nAction items:\n- Check tomorrow");
  eq("admin_recording_urls fallback", pickRecordingUrl({ admin_recording_urls: ["https://dialpad.com/blob/adminrecording/52.mp3"] }), "https://dialpad.com/blob/adminrecording/52.mp3");
  eq("admin recording id", adminRecordingId("https://dialpad.com/blob/adminrecording/5225818665820160.mp3"), "5225818665820160");
  eq("user recording is not an admin recording", adminRecordingId("https://dialpad.com/r/5225818665820160"), null);
  eq("scope error detected", isDialpadScopeError(new Error("Dialpad GET /api/v2/call/1/ai_recap → 403: {\n \"message\": \"Missing required scope(s): ['ai_recap']\"}")), true);
  eq("other 403 is not a scope error", isDialpadScopeError(new Error("Dialpad GET /x → 403: forbidden")), false);
  // recap_outcome arriving after recap_summary keeps the summary.
  const afterSummary = buildCallPatch(null, { call_id: 1, state: "recap_summary", recap_summary: "Feed reset." });
  const afterOutcome = buildCallPatch(afterSummary, { call_id: 1, state: "recap_outcome", recap_outcome: "Resolved" });
  eq("recap parts merge across events", afterOutcome.summary, "Feed reset.\n\nOutcome: Resolved");
  eq("API recap merges with events", buildSummary(mergedRecap({ ai_recap: { recap_summary: "S", recap_action_items: ["A"] } }, {})), "S\n\nAction items:\n- A");

  const ringing = { call_id: 1, state: "ringing", direction: "inbound", external_number: "8015550100", internal_number: "+18014159435", date_started: 1700000000000, event_timestamp: 1700000000500 };
  const p1 = buildCallPatch(null, ringing);
  eq("inbound: from = external, to = internal", [p1.from_number, p1.to_number, p1.state], ["+18015550100", "+18014159435", "ringing"]);
  const p2 = buildCallPatch(p1, { ...ringing, state: "hangup", date_connected: 1700000005000, date_ended: 1700000065000, duration: 60000.4, event_timestamp: 1700000065100 });
  eq("hangup fills answered/ended/duration", [p2.state, p2.duration_sec, !!p2.answered_at, !!p2.ended_at], ["completed", 60, true, true]);
  const late = buildCallPatch(p2, { ...ringing, state: "connected", event_timestamp: 1700000004000 });
  eq("late 'connected' after hangup keeps completed + newest event time", [late.state, late.last_event_at], ["completed", p2.last_event_at]);
  eq("raw keeps one payload per state", Object.keys(late.raw ?? {}).sort(), ["connected", "hangup", "ringing"]);
  eq("subject", callSubject({ direction: "inbound", state: "completed", from_number: "+18015550100", to_number: null, duration_sec: 252 }),
    "Inbound call from (801) 555-0100 — completed (4m 12s)");
  eq("transcript formatting skips moments", formatTranscript([
    { name: "Marlena", content: "Hi!", type: "transcript" }, { name: null, content: "Pricing", type: "moment" }, { name: "Chris", content: " Hello ", type: "transcript" },
  ]), "Marlena: Hi!\nChris: Hello");

  // ── .env.local parsing (lib/crm/env.ts — app-runtime loader, no dotenv) ────
  eq("env file parsing", parseEnvFile([
    "# comment", "DIALPAD_API_KEY=abc123", "export MS_TENANT_ID = 'tenant-1'", 'MS_CLIENT_SECRET="s3cr#t\\nx"',
    "DIALPAD_COMPANY_ID=42 # trailing comment", "EMPTY=", "not a line",
  ].join("\n")), { DIALPAD_API_KEY: "abc123", MS_TENANT_ID: "tenant-1", MS_CLIENT_SECRET: "s3cr#t\nx", DIALPAD_COMPANY_ID: "42", EMPTY: "" });

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
