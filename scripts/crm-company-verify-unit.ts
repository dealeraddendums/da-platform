/* npm run test:crm-company — DA-CRM company page pure logic: the AI summary's
   data assembly, debounce and output parsing; billing state from DA-Billing's
   reads; owner auto-clear on conversion; task / ticket validation; feed name and
   inventory freshness. No database
   or network. */
import { assembleSummaryInput, hasAnyActivity, latestChange, parseSummary, summaryDue, DEBOUNCE_MS, type SummaryData } from "../lib/crm/company-summary";
import { deriveBillingState } from "../lib/crm/billing-status";
import { ownerForStage } from "../lib/crm/companies";
import { workPatch } from "../lib/crm/work-items";
import { feedName, inventoryFreshness, isFed } from "../lib/crm/inventory-freshness";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

const NOW = new Date("2026-10-22T18:00:00Z");
const iso = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

function data(over: Partial<SummaryData> = {}): SummaryData {
  return {
    company: { id: "c1", name: "Riverside Motors", kind: "dealer", stage: "trial", billing: null, trial_day: 12, trial_ends_on: "2026-11-09", trial_flag: null, owner: "Alex Friedrich", brands: ["Ford"], city: "Provo", state: "UT" },
    activities: [
      { id: "a-new", type: "email", direction: "inbound", subject: "Labels look off", body: "<p>The <b>price</b> is cut off</p>", occurred_at: iso(30), created_at: iso(30), actor: null, contact: "Dana Ruiz" },
      { id: "a-old", type: "call", direction: "outbound", subject: "Outbound call — completed (4m)", body: null, occurred_at: iso(60 * 24 * 5), created_at: iso(60 * 24 * 5), actor: "Alex Friedrich", contact: null },
    ],
    olderActivities: [], olderCount: 0,
    tickets: [{ id: "k1", title: "Label template cuts off price", status: "open", priority: "high", description: null, created_at: iso(20), resolved_at: null }],
    tasks: [{ id: "t1", title: "Call Dana back", status: "open", description: "re labels", due_at: iso(-60 * 24), created_at: iso(25), completed_at: null, assignee: "Alex Friedrich" }],
    feedOrders: [],
    ...over,
  };
}

async function main() {
  // ── Data assembly ─────────────────────────────────────────────────────────
  const a = assembleSummaryInput(data());
  eq("refs: company, ticket, task, both activities", Object.keys(a.refs), ["C", "K1", "T1", "A1", "A2"]);
  eq("A1 is the newest activity", a.refs.A1.id, "a-new");
  eq("company line carries stage, trial day, owner", a.text.split("\n")[0].includes("stage: Trial · trial day 12, ends 2026-11-09 · owner: Alex Friedrich"), true);
  eq("html stripped from bodies", a.text.includes("The price is cut off"), true);
  eq("open work is listed before activities", a.text.indexOf("[K1]") < a.text.indexOf("[A1]") && a.text.indexOf("[T1]") < a.text.indexOf("[A1]"), true);
  eq("nothing folded under budget", a.folded, 0);
  eq("paying dealer shows its billing state", assembleSummaryInput(data({ company: { ...data().company, stage: "paying", billing: "past_due", trial_day: null } })).text.includes("stage: Past Due"), true);

  // Budget: activities that don't fit fold into one [H] line; open work still fits.
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `x${i}`, type: "email", direction: "inbound", subject: `Thread ${i}`, body: "lorem ipsum ".repeat(60), occurred_at: iso(60 + i), created_at: iso(60 + i), actor: null, contact: null }));
  const b = assembleSummaryInput(data({ activities: many, olderCount: 7, olderActivities: [{ type: "call", subject: "Intro call", occurred_at: "2026-05-01T15:00:00Z" }] }), 3000);
  eq("budget: some activities included", b.included > 0 && b.included < 120, true);
  eq("budget: the rest + older history fold into H", b.folded, 120 - b.included + 7);
  eq("budget: H ref present", b.refs.H?.label, `${120 - b.included + 7} earlier items`);
  eq("budget: open ticket kept", "K1" in b.refs && "T1" in b.refs, true);
  eq("budget: stays near the cap", Math.ceil(b.text.length / 4) < 3000 + 800, true);

  eq("latestChange spans tasks / tickets / activities", latestChange(data()), iso(20));
  eq("hasAnyActivity false on an empty record", hasAnyActivity(data({ activities: [], tickets: [], tasks: [] })), false);
  eq("hasAnyActivity counts older-only history", hasAnyActivity(data({ activities: [], tickets: [], tasks: [], olderCount: 3 })), true);

  // ── Debounce ──────────────────────────────────────────────────────────────
  const fresh = { generated_at: iso(10), hwm: iso(15), started_at: null };
  eq("no activity → never", summaryDue({ generated_at: null, hwm: null, started_at: null }, null, NOW, true).reason, "no_activity");
  eq("first view generates", summaryDue({ generated_at: null, hwm: null, started_at: null }, iso(5), NOW, false), { due: true, reason: "first" });
  eq("nothing new → up to date", summaryDue(fresh, iso(15), NOW, false), { due: false, reason: "up_to_date" });
  eq("new activity inside the hour → debounced", summaryDue(fresh, iso(1), NOW, false), { due: false, reason: "debounced" });
  eq("new activity after the hour → due", summaryDue({ generated_at: new Date(NOW.getTime() - DEBOUNCE_MS - 1).toISOString(), hwm: iso(90), started_at: null }, iso(1), NOW, false), { due: true, reason: "new_activity" });
  eq("manual skips the hour", summaryDue(fresh, iso(15), NOW, true), { due: true, reason: "manual" });
  eq("in-flight claim blocks even manual", summaryDue({ ...fresh, started_at: iso(1) }, iso(1), NOW, true), { due: false, reason: "in_flight" });
  eq("stale claim (>3 min) is ignored", summaryDue({ generated_at: null, hwm: null, started_at: iso(10) }, iso(1), NOW, false).due, true);

  // ── Output parsing ────────────────────────────────────────────────────────
  const refs = a.refs;
  const p = parseSummary('Sure: {"sentences":[{"text":"Riverside is on trial day 12.","sources":["C"]},{"text":"Dana says  the price is cut off.","sources":["A1","ZZ"]}],"next_step":{"text":"Call Dana back.","sources":["T1"]}}', refs);
  eq("parse: unknown source dropped", p?.sentences[1].sources, ["A1"]);
  eq("parse: whitespace collapsed", p?.sentences[1].text, "Dana says the price is cut off.");
  eq("parse: only cited refs kept", Object.keys(p?.refs ?? {}).sort(), ["A1", "C", "T1"]);
  eq("parse: next step kept", p?.next_step?.text, "Call Dana back.");
  eq("parse: at most 6 sentences", parseSummary(JSON.stringify({ sentences: Array.from({ length: 9 }, (_, i) => ({ text: `S${i}.`, sources: ["C"] })) }), refs)?.sentences.length, 6);
  eq("parse: junk → null", parseSummary("I can't do that", refs), null);
  eq("parse: no sentences → null", parseSummary('{"sentences":[]}', refs), null);

  // ── Billing state ─────────────────────────────────────────────────────────
  eq("past_due (print lock) → suspended", deriveBillingState(true, [], NOW), "suspended");
  eq("unpaid past its due date → past due", deriveBillingState(false, [{ status: "pending", dueDate: "2026-10-01" }], NOW), "past_due");
  eq("paid late invoice doesn't count", deriveBillingState(false, [{ status: "paid", dueDate: "2026-10-01" }], NOW), "current");
  eq("archived doesn't count", deriveBillingState(false, [{ status: "pending", dueDate: "2026-10-01", archived: true }], NOW), "current");
  eq("due later → current", deriveBillingState(false, [{ status: "pending", dueDate: "2026-11-01" }], NOW), "current");

  // ── Owner auto-clear ──────────────────────────────────────────────────────
  eq("converting to paying clears the owner", ownerForStage("paying", "u1", undefined), { owner: null });
  eq("paying with no owner: no change", ownerForStage("paying", null, undefined), {});
  eq("paying can't be given an owner", ownerForStage("paying", null, { owner: "u2" }).error, "Current customers have no owner");
  eq("unassigning a paying dealer is fine", ownerForStage("paying", null, { owner: null }), {});
  eq("trial keeps its owner", ownerForStage("trial", "u1", undefined), {});
  eq("trial owner change goes through", ownerForStage("trial", "u1", { owner: "u2" }), { owner: "u2" });
  eq("setup & training can be owned", ownerForStage("setup_training", null, { owner: "u2" }), { owner: "u2" });

  // ── Tasks / tickets ───────────────────────────────────────────────────────
  eq("task needs a title", workPatch("task", { title: "  " }, true), { error: "Title required" });
  const done = workPatch("task", { status: "done" }, false) as { patch: Record<string, unknown> };
  eq("closing a task stamps completed_at", typeof done.patch.completed_at, "string");
  eq("reopening clears completed_at", (workPatch("task", { status: "open" }, false) as any).patch.completed_at, null);
  eq("ticket priority validated", workPatch("ticket", { priority: "asap" }, false), { error: "Bad priority" });
  eq("ticket resolved stamps resolved_at", typeof (workPatch("ticket", { status: "resolved" }, false) as any).patch.resolved_at, "string");
  eq("ticket pending is still open (no resolved_at)", (workPatch("ticket", { status: "pending" }, false) as any).patch.resolved_at, null);
  eq("bad due date refused", workPatch("task", { title: "x", due_at: "soon" }, true), { error: "Bad due date" });

  // ── Feed name + inventory freshness ───────────────────────────────────────
  eq("feed name prefers inventory_provider", feedName("CDK", "Vauto"), "CDK");
  eq("feed name falls back to feed_source", feedName(null, " Homenet "), "Homenet");
  eq("no feed name", feedName("", ""), null);
  eq("manual dealer isn't fed", isFed("Manual", null), false);
  eq("feed id alone counts as fed", isFed(null, "ss_123"), true);
  eq("added today", inventoryFreshness(iso(60), true, NOW), { newest: iso(60), days: 0, stale: false, label: "Today" });
  eq("2 days: not stale", inventoryFreshness(iso(60 * 24 * 2 + 5), true, NOW).stale, false);
  eq("3 days: stale (red)", inventoryFreshness(iso(60 * 24 * 3), true, NOW), { newest: iso(60 * 24 * 3), days: 3, stale: true, label: "3 days ago" });
  eq("manual dealer never red", inventoryFreshness(iso(60 * 24 * 30), false, NOW).stale, false);
  eq("fed dealer with no vehicles is red", inventoryFreshness(null, true, NOW), { newest: null, days: null, stale: true, label: "No vehicles yet" });

  console.log(fail ? `\n${fail} failed` : "\nall passed");
  if (fail) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
