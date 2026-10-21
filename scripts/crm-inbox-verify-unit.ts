/* npm run test:crm-inbox — DA-CRM Phase 2 Inbox logic, no database or network:
   email → company / contact matching (contact email, company emails, domain,
   free-mail, ambiguity, internal), the ignore list, Graph message
   normalization, reply-all detection, reply / draft payload shape, the
   onInboundEmail registry, display sanitizing, clientState — and the full
   ingest path (thread + email + activity + hook, dedupe on the immutable id
   and on Message-ID) against an in-memory Supabase fake. */
/* eslint-disable @typescript-eslint/no-explicit-any */
process.env.MS_GRAPH_WEBHOOK_SECRET = "test-client-state";

import { matchEmailParticipants, isIgnoredSender, isInternalAddress, normEmail, type EmailMatchLookup } from "../lib/crm/inbox-match";
import { normalizeGraphMessage, skipReason, isReplyAll, priorMessage, participantsOf, matchOrder, baseSubject, snippet } from "../lib/crm/inbox-message";
import { buildDraftPatch, mergeQuotedBody, toGraphRecipients, validClientState, subscriptionResource, initialDeltaUrl } from "../lib/crm/graph";
import { registerInboundEmailHandler, unregisterInboundEmailHandler, dispatchInboundEmail, type InboundEmailEvent } from "../lib/crm/email-hooks";
import { displayEmailHtml } from "../lib/crm/inbox-display";
import { ingestGraphMessage, attachmentKey, type InboxContext, type Mailbox } from "../lib/crm/inbox-ingest";
import { cleanRecipients } from "../lib/crm/inbox-send";

let fail = 0, pass = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const RULES = { ownAddresses: ["support@dealeraddendums.com", "feeds@dealeraddendums.com"], internalDomains: ["dealeraddendums.com"], ignoreSenders: ["noreply@", "no-reply@", "mailer-daemon@", "bounce", "@mandrillapp.com", "notifications@"] };

function lookup(data: { contacts?: Record<string, any[]>; companyEmails?: Record<string, any[]>; domains?: Record<string, any[]> }): EmailMatchLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async contactsByEmail(e) { calls.push(`contact:${e}`); return data.contacts?.[e] ?? []; },
    async companiesByEmail(e) { calls.push(`coemail:${e}`); return data.companyEmails?.[e] ?? []; },
    async companiesByDomain(d) { calls.push(`domain:${d}`); return data.domains?.[d] ?? []; },
  };
}
const co = (id: string, kind = "dealer", active = true) => ({ id, kind, active });

async function main() {
  // ── Address helpers ─────────────────────────────────────────────────────
  eq("normEmail lowercases + strips name", normEmail("Jane Doe <Jane.Doe@ToyotaOfX.com>"), "jane.doe@toyotaofx.com");
  eq("normEmail mailto:", normEmail("mailto:GM@dealer.com"), "gm@dealer.com");
  eq("normEmail rejects junk", normEmail("not an email"), null);
  eq("internal: our mailbox", isInternalAddress("feeds@dealeraddendums.com", RULES), true);
  eq("internal: staff address", isInternalAddress("allan@dealeraddendums.com", RULES), true);
  eq("internal: subdomain", isInternalAddress("x@mail.dealeraddendums.com", RULES), true);
  eq("internal: lookalike domain is external", isInternalAddress("x@notdealeraddendums.com", RULES), false);

  // ── Matching ────────────────────────────────────────────────────────────
  {
    const l = lookup({ contacts: { "gm@toyotaofx.com": [{ id: "ct-old", company_id: "c1", updated_at: "2026-01-01" }, { id: "ct-new", company_id: "c2", updated_at: "2026-09-01" }] } });
    const m = await matchEmailParticipants(["GM@ToyotaOfX.com"], l, RULES);
    eq("match: contact email (case-insensitive), most recent contact wins", [m.companyId, m.contactId, m.matchedBy], ["c2", "ct-new", "contact"]);
  }
  {
    const l = lookup({ companyEmails: { "sales-desk@hondaofy.com": [co("c9", "vendor"), co("c3")] } });
    const m = await matchEmailParticipants(["sales-desk@hondaofy.com"], l, RULES);
    eq("match: crm_companies.emails, dealer preferred", [m.companyId, m.contactId, m.matchedBy], ["c3", null, "company_email"]);
  }
  {
    const l = lookup({ domains: { "kiaofz.com": [co("c4")] } });
    const m = await matchEmailParticipants(["someone@kiaofz.com"], l, RULES);
    eq("match: single company on the domain", [m.companyId, m.matchedBy], ["c4", "domain"]);
  }
  {
    const l = lookup({ domains: { "bigauto.com": [co("d1"), co("d2"), co("g1", "group")] } });
    const m = await matchEmailParticipants(["ceo@bigauto.com"], l, RULES);
    eq("match: shared domain with exactly one group → the group", [m.companyId, m.matchedBy], ["g1", "domain"]);
  }
  {
    const l = lookup({ domains: { "twostores.com": [co("d1"), co("d2")] } });
    const m = await matchEmailParticipants(["x@twostores.com"], l, RULES);
    eq("match: ambiguous domain → unassigned with candidates", [m.companyId, m.candidates], [null, ["d1", "d2"]]);
  }
  {
    const l = lookup({ domains: { "gmail.com": [co("wrong")] } });
    const m = await matchEmailParticipants(["dealerguy@gmail.com"], l, RULES);
    eq("match: free-mail domain never matches by domain", [m.companyId, l.calls.includes("domain:gmail.com")], [null, false]);
  }
  {
    const l = lookup({ contacts: { "cc@dealer.com": [{ id: "ct", company_id: "c5", updated_at: "2026-01-01" }] }, domains: { "first.com": [co("c6")] } });
    const m = await matchEmailParticipants(["a@first.com", "cc@dealer.com"], l, RULES);
    eq("match: an exact address anywhere beats a domain on the first participant", [m.companyId, m.matchedBy], ["c5", "contact"]);
  }
  {
    const l = lookup({});
    const m = await matchEmailParticipants(["allan@dealeraddendums.com", "support@dealeraddendums.com"], l, RULES);
    eq("match: only our addresses → internal, no lookups", [m.internal, m.companyId, l.calls.length], [true, null, 0]);
  }
  {
    const l = lookup({});
    const m = await matchEmailParticipants(["nobody@unknown-dealer.com"], l, RULES);
    eq("match: unknown → unassigned, not internal", [m.companyId, m.internal, m.external], [null, false, ["nobody@unknown-dealer.com"]]);
  }

  // ── Ignore list / skip rules ───────────────────────────────────────────
  eq("ignore: noreply@", isIgnoredSender("noreply@vendor.com", RULES.ignoreSenders), true);
  eq("ignore: bounces+…", isIgnoredSender("bounces+123@em.example.com", RULES.ignoreSenders), true);
  eq("ignore: Mandrill", isIgnoredSender("x@mandrillapp.com", RULES.ignoreSenders), true);
  eq("ignore: a person", isIgnoredSender("jane@dealer.com", RULES.ignoreSenders), false);
  const mk = (over: any = {}) => ({
    id: "AAMk-1", conversationId: "conv-1", internetMessageId: "<m1@dealer.com>", subject: "Question about labels",
    from: { emailAddress: { address: "Jane@Dealer.com", name: "Jane Doe" } },
    toRecipients: [{ emailAddress: { address: "support@dealeraddendums.com", name: "DealerAddendums Support" } }],
    ccRecipients: [{ emailAddress: { address: "gm@dealer.com", name: "gm@dealer.com" } }],
    bccRecipients: [], receivedDateTime: "2026-10-20T15:00:00Z", hasAttachments: false, isDraft: false,
    body: { contentType: "html", content: "<html><head><style>p{}</style></head><body><p>Hi,&nbsp;can you help?</p></body></html>" },
    internetMessageHeaders: [{ name: "In-Reply-To", value: "<m0@dealeraddendums.com>" }],
    ...over,
  });
  eq("skip: normal message", skipReason(mk(), "support@dealeraddendums.com", RULES), null);
  eq("skip: draft", skipReason(mk({ isDraft: true }), "support@dealeraddendums.com", RULES), "draft");
  eq("skip: calendar invite (eventMessage)", skipReason(mk({ "@odata.type": "#microsoft.graph.eventMessageRequest" }), "support@dealeraddendums.com", RULES), "calendar");
  eq("skip: ignored sender", skipReason(mk({ from: { emailAddress: { address: "no-reply@portal.com" } } }), "support@dealeraddendums.com", RULES), "ignored sender");
  eq("skip: our own outbound is never 'automated'", skipReason(mk({ from: { emailAddress: { address: "support@dealeraddendums.com" } } }), "support@dealeraddendums.com", { ignoreSenders: ["support@"] }), null);

  // ── Normalization ──────────────────────────────────────────────────────
  const n = normalizeGraphMessage(mk(), "support@dealeraddendums.com", "inbox");
  eq("normalize: direction inbound", n.direction, "inbound");
  eq("normalize: from lowercased, name kept", n.from, { email: "jane@dealer.com", name: "Jane Doe" });
  eq("normalize: name equal to address dropped", n.cc, [{ email: "gm@dealer.com", name: null }]);
  eq("normalize: In-Reply-To from headers", n.inReplyTo, "<m0@dealeraddendums.com>");
  eq("normalize: text body without <style>", n.bodyText, "Hi, can you help?");
  eq("normalize: raw has no body", "body" in n.raw, false);
  eq("normalize: Sent Items folder → outbound", normalizeGraphMessage(mk(), "support@dealeraddendums.com", "sentitems").direction, "outbound");
  eq("normalize: from the mailbox → outbound", normalizeGraphMessage(mk({ from: { emailAddress: { address: "SUPPORT@dealeraddendums.com" } } }), "support@dealeraddendums.com").direction, "outbound");
  eq("participants: from + to + cc with roles", participantsOf(n).map((p) => `${p.role}:${p.address}`), ["from:jane@dealer.com", "to:support@dealeraddendums.com", "cc:gm@dealer.com"]);
  eq("matchOrder inbound: sender first", matchOrder(n), ["jane@dealer.com", "support@dealeraddendums.com", "gm@dealer.com"]);
  eq("baseSubject strips RE/FW chains", baseSubject("RE: Fw: RE[2]: Feed request"), "Feed request");
  eq("snippet collapses whitespace", snippet("a\n\n  b   c", 10), "a b c");

  // ── Reply-all ──────────────────────────────────────────────────────────
  const A = (email: string) => ({ email, name: null });
  const feedsRequest = { from: A("feeds@dealeraddendums.com"), to: [A("approver@dealer.com")], cc: [A("orders@supplier.com")] };
  eq("reply-all: approver replies to feeds@ + supplier", isReplyAll({ from: A("approver@dealer.com"), to: [A("feeds@dealeraddendums.com")], cc: [A("orders@supplier.com")] }, feedsRequest), true);
  eq("reply-all: approver replies only to feeds@", isReplyAll({ from: A("approver@dealer.com"), to: [A("feeds@dealeraddendums.com")], cc: [] }, feedsRequest), false);
  eq("reply-all: only one other person → plain reply", isReplyAll({ from: A("jane@dealer.com"), to: [A("support@dealeraddendums.com")], cc: [] }, { from: A("support@dealeraddendums.com"), to: [A("jane@dealer.com")], cc: [] }), false);
  eq("reply-all: our reply to everyone", isReplyAll({ from: A("support@dealeraddendums.com"), to: [A("jane@dealer.com")], cc: [A("gm@dealer.com")] }, { from: A("jane@dealer.com"), to: [A("support@dealeraddendums.com")], cc: [A("gm@dealer.com")] }), true);
  eq("reply-all: no prior message", isReplyAll({ from: A("x@y.com"), to: [A("a@b.com"), A("c@d.com")], cc: [] }, null), false);
  const hist = [{ internet_message_id: "<a>", received_at: "2026-10-01T00:00:00Z" }, { internet_message_id: "<b>", received_at: "2026-10-02T00:00:00Z" }, { internet_message_id: "<c>", received_at: "2026-10-05T00:00:00Z" }];
  eq("prior: In-Reply-To wins", priorMessage(hist, "<a>", "2026-10-06T00:00:00Z")?.internet_message_id, "<a>");
  eq("prior: else latest earlier message", priorMessage(hist, "<zzz>", "2026-10-03T00:00:00Z")?.internet_message_id, "<b>");

  // ── Reply / draft payload shape ────────────────────────────────────────
  eq("recipients: lowercased, deduped, Graph shape", toGraphRecipients([{ email: "Jane@Dealer.com", name: "Jane" }, { email: "jane@dealer.com" }, { email: "gm@dealer.com", name: " " }]),
    [{ emailAddress: { address: "jane@dealer.com", name: "Jane" } }, { emailAddress: { address: "gm@dealer.com" } }]);
  eq("quoted body: ours goes inside <body>, above Outlook's history",
    mergeQuotedBody("<div>OURS</div>", "<html><head></head><body dir=\"ltr\"><hr><div>quoted</div></body></html>"),
    "<html><head></head><body dir=\"ltr\"><div>OURS</div><hr><div>quoted</div></body></html>");
  eq("quoted body: no <body> → prepend", mergeQuotedBody("<p>A</p>", "<div>q</div>"), "<p>A</p><div>q</div>");
  eq("quoted body: none → ours only", mergeQuotedBody("<p>A</p>", ""), "<p>A</p>");
  const patch = buildDraftPatch({ subject: "RE: Labels", html: "<p>Hi</p>", quotedHtml: null, to: [{ email: "a@x.com" }], cc: [], bcc: [{ email: "B@x.com" }] });
  eq("draft PATCH shape", patch, { subject: "RE: Labels", body: { contentType: "HTML", content: "<p>Hi</p>" }, toRecipients: [{ emailAddress: { address: "a@x.com" } }], ccRecipients: [], bccRecipients: [{ emailAddress: { address: "b@x.com" } }] });
  eq("draft PATCH: subject omitted when null", "subject" in buildDraftPatch({ subject: null, html: "x", to: [], cc: [], bcc: [] }), false);
  eq("send: cleanRecipients drops invalid + dupes", cleanRecipients([{ email: "A@b.com" }, { email: "a@b.com" }, { email: "nope" }]), [{ email: "a@b.com", name: null }]);
  eq("subscription resource", subscriptionResource("feeds@dealeraddendums.com", "sentitems"), "users/feeds@dealeraddendums.com/mailFolders('sentitems')/messages");
  eq("delta URL: ids only + receivedDateTime filter", initialDeltaUrl("support@dealeraddendums.com", "inbox", new Date("2026-07-22T00:00:00.000Z")),
    "https://graph.microsoft.com/v1.0/users/support%40dealeraddendums.com/mailFolders/inbox/messages/delta?$select=id,isDraft&$filter=receivedDateTime%20ge%202026-07-22T00%3A00%3A00Z");
  eq("clientState: match", validClientState("test-client-state"), true);
  eq("clientState: mismatch / missing", [validClientState("nope"), validClientState(undefined)], [false, false]);
  eq("attachment key: under the email row's uuid, filename made safe", attachmentKey(null, "e-1", "Signed form (1)/../x?.pdf"), "crm/unmatched/email/e-1/Signed form (1)_.._x_.pdf");

  // ── Display sanitizing ─────────────────────────────────────────────────
  const shown = displayEmailHtml(`<html><head></head><body><script>alert(1)</script><p onclick="x()">Hi</p><img src="cid:img001@01D9"><form action="https://evil"><input></form></body></html>`, null, { "img001@01D9": "/api/crm/inbox/attachments/att-1" });
  eq("display: script / handlers / forms removed", [/script|onclick|<form|<input/i.test(shown)], [false]);
  eq("display: cid image → attachment route", shown.includes(`src="/api/crm/inbox/attachments/att-1"`), true);
  eq("display: links open in a new tab", shown.includes(`<base target="_blank">`), true);
  eq("display: text fallback escaped", displayEmailHtml(null, "<b>x</b>", {}).includes("&lt;b&gt;"), true);

  // ── onInboundEmail registry ────────────────────────────────────────────
  {
    const seen: string[] = [];
    registerInboundEmailHandler("t-all", (e) => { seen.push(`all:${e.email.id}`); });
    registerInboundEmailHandler("t-feeds", (e) => { seen.push(`feeds:${e.email.id}`); }, { purpose: "feeds" });
    registerInboundEmailHandler("t-throws", () => { throw new Error("boom"); });
    registerInboundEmailHandler("t-after", (e) => { seen.push(`after:${e.email.id}`); });
    const ev = (purpose: "support" | "feeds"): InboundEmailEvent => ({
      email: { id: `e-${purpose}`, thread_id: "t", mailbox_id: "m", graph_message_id: "g", internet_message_id: null, in_reply_to: null, from_email: "a@b.com", from_name: null, to: [], cc: [], subject: null, body_text: null, body_html: null, received_at: "2026-10-20T00:00:00Z", is_reply_all: false, has_attachments: false },
      thread: { id: "t", company_id: null, contact_id: null, subject: null, status: "open", internal: false, message_count: 1 },
      mailbox: { id: "m", address: `${purpose}@dealeraddendums.com`, purpose },
    });
    const r1 = await dispatchInboundEmail(ev("support"));
    const r2 = await dispatchInboundEmail(ev("feeds"));
    eq("hooks: purpose filter + a throwing handler doesn't stop the rest", seen, ["all:e-support", "after:e-support", "all:e-feeds", "feeds:e-feeds", "after:e-feeds"]);
    eq("hooks: failures reported", [r1.find((x) => x.name === "t-throws")?.ok, r2.length], [false, 4]);
    ["t-all", "t-feeds", "t-throws", "t-after"].forEach(unregisterInboundEmailHandler);
  }

  // ── Ingest end-to-end (in-memory Supabase) ─────────────────────────────
  {
    const db = fakeDb({
      crm_contacts: [{ id: "ct-jane", company_id: "co-dealer", email: "jane@dealer.com", updated_at: "2026-09-01", deleted_at: null }],
    });
    const mb: Mailbox = { id: "mb-support", address: "support@dealeraddendums.com", display_name: "Support", purpose: "support", active: true };
    const ctx: InboxContext = { mailboxes: [mb], rules: RULES, loadedAt: Date.now() };
    const fired: string[] = [];
    registerInboundEmailHandler("t-ingest", (e) => { fired.push(e.email.id); });

    const r1 = await ingestGraphMessage(db, mb, mk(), { folder: "inbox", ctx });
    eq("ingest: stored", r1.status, "stored");
    const t = db.rows("crm_email_threads")[0];
    eq("ingest: thread matched to the contact's company", [t.company_id, t.contact_id, t.matched_by, t.unread, t.internal, t.message_count], ["co-dealer", "ct-jane", "contact", true, false, 1]);
    eq("ingest: thread list fields", [t.last_from_email, t.last_snippet, t.subject], ["jane@dealer.com", "Hi, can you help?", "Question about labels"]);
    const act = db.rows("crm_activities")[0];
    eq("ingest: timeline activity (email, inbound, company)", [act.type, act.direction, act.company_id, act.external_id], ["email", "inbound", "co-dealer", "graph:support@dealeraddendums.com:<m1@dealer.com>"]);
    eq("ingest: email links its activity", db.rows("crm_emails")[0].activity_id, act.id);
    eq("ingest: participants stored", db.rows("crm_email_participants").length, 3);
    eq("ingest: onInboundEmail fired once", fired.length, 1);

    const r2 = await ingestGraphMessage(db, mb, mk(), { folder: "inbox", ctx });
    eq("dedupe: same immutable id → duplicate, nothing new, hook not re-fired", [r2.status, db.rows("crm_emails").length, db.rows("crm_activities").length, fired.length], ["duplicate", 1, 1, 1]);
    const r3 = await ingestGraphMessage(db, mb, mk({ id: "AAMk-other-id" }), { folder: "inbox", ctx });
    eq("dedupe: same Message-ID in the mailbox under another id → duplicate", [r3.status, db.rows("crm_emails").length], ["duplicate", 1]);

    // Our reply (sent from DA-CRM): stored once, attributed, reply-all detected; Sent Items sync then dedupes it.
    const reply = mk({
      id: "AAMk-reply", internetMessageId: "<r1@dealeraddendums.com>", subject: "RE: Question about labels", receivedDateTime: "2026-10-20T16:00:00Z",
      from: { emailAddress: { address: "support@dealeraddendums.com" } }, toRecipients: [{ emailAddress: { address: "jane@dealer.com" } }], ccRecipients: [{ emailAddress: { address: "gm@dealer.com" } }],
      internetMessageHeaders: [],
    });
    const r4 = await ingestGraphMessage(db, mb, reply, { folder: "sentitems", ctx, sentByStaffId: "staff-1" });
    const sent = db.rows("crm_emails").find((e: any) => e.graph_message_id === "AAMk-reply");
    eq("send: stored as outbound, sent_by, reply-all", [r4.status, sent?.direction, sent?.sent_by_staff_id, sent?.is_reply_all], ["stored", "outbound", "staff-1", true]);
    eq("send: hook not fired for outbound", fired.length, 1);
    const r5 = await ingestGraphMessage(db, mb, reply, { folder: "sentitems", ctx });
    eq("dedupe: Sent Items sync of a message DA-CRM sent", [r5.status, db.rows("crm_emails").length], ["duplicate", 2]);
    const t2 = db.rows("crm_email_threads")[0];
    eq("thread roll-up after reply", [t2.message_count, t2.last_direction, db.rows("crm_email_threads").length], [2, "outbound", 1]);

    // Sync stored our sent mail first → the send claims it.
    const early = mk({ id: "AAMk-early", conversationId: "conv-2", internetMessageId: "<e1@dealeraddendums.com>", from: { emailAddress: { address: "support@dealeraddendums.com" } }, toRecipients: [{ emailAddress: { address: "x@unknown.com" } }], ccRecipients: [] });
    await ingestGraphMessage(db, mb, early, { folder: "sentitems", ctx });
    await ingestGraphMessage(db, mb, early, { folder: "sentitems", ctx, sentByStaffId: "staff-2" });
    eq("dedupe: a later send claims the row the sync stored", db.rows("crm_emails").find((e: any) => e.graph_message_id === "AAMk-early")?.sent_by_staff_id, "staff-2");

    const r6 = await ingestGraphMessage(db, mb, mk({ id: "AAMk-nr", internetMessageId: "<nr@x>", from: { emailAddress: { address: "noreply@portal.com" } } }), { ctx });
    eq("ingest: ignored sender never stored", [r6.status, db.rows("crm_emails").length], ["skipped", 3]);
    unregisterInboundEmailHandler("t-ingest");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

// ── In-memory Supabase fake: just the query surface lib/crm/inbox-ingest.ts uses ──
function fakeDb(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = { crm_email_threads: [], crm_emails: [], crm_email_participants: [], crm_activities: [], crm_contacts: [], ...seed };
  const uniques: Record<string, string[][]> = {
    crm_email_threads: [["mailbox_id", "graph_conversation_id"]],
    crm_emails: [["graph_message_id"], ["mailbox_id", "internet_message_id"]],
    crm_email_participants: [["email_id", "address", "role"]],
    crm_activities: [["type", "external_id"]],
  };
  let seq = 0;
  const clash = (t: string, row: any, cols?: string[]) => (cols ? [cols] : uniques[t] ?? []).map((c) => tables[t].find((r) => c.every((k) => row[k] != null && r[k] === row[k]))).find(Boolean);
  function builder(t: string) {
    let filters: ((r: any) => boolean)[] = [];
    let op: { kind: "select" | "insert" | "upsert" | "update"; rows?: any[]; patch?: any; onConflict?: string; ignore?: boolean } = { kind: "select" };
    let limit = Infinity;
    const run = () => {
      const all = tables[t] ?? (tables[t] = []);
      if (op.kind === "insert" || op.kind === "upsert") {
        const out: any[] = [];
        for (const raw of op.rows!) {
          const row = { id: `${t}-${++seq}`, ...raw };
          const hit = op.kind === "upsert" && op.onConflict ? clash(t, row, op.onConflict.split(",")) : null;
          if (hit) { if (!op.ignore) { Object.assign(hit, raw); out.push(hit); } continue; }
          if (clash(t, row)) return { data: null, error: { code: "23505", message: "duplicate key" } };
          all.push(row); out.push(row);
        }
        return { data: out, error: null };
      }
      const hits = all.filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") { hits.forEach((r) => Object.assign(r, op.patch)); return { data: hits, error: null }; }
      return { data: hits.slice(0, limit), error: null };
    };
    const b: any = {
      select() { return b; },
      insert(rows: any) { op = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] }; return b; },
      upsert(rows: any, o: any = {}) { op = { kind: "upsert", rows: Array.isArray(rows) ? rows : [rows], onConflict: o.onConflict, ignore: !!o.ignoreDuplicates }; return b; },
      update(patch: any) { op = { kind: "update", patch }; return b; },
      eq(k: string, v: any) { filters.push((r) => r[k] === v); return b; },
      is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(r[k])); return b; },
      not(k: string, _op: string, _v: any) { filters.push((r) => r[k] != null); return b; },
      ilike(k: string, v: string) { const want = v.replace(/\\([\\%_])/g, "$1").toLowerCase(); filters.push((r) => String(r[k] ?? "").toLowerCase() === want); return b; },
      order() { return b; },
      limit(n: number) { limit = n; return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { message: "no rows" }) }); },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: [], error: null }),
    rows: (t: string) => tables[t] ?? [],
  } as any;
}

main().catch((e) => { console.error(e); process.exit(1); });
