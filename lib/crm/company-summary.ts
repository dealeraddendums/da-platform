// DA-CRM company AI summary: plain sentences (no fixed count) + a "Next step", grounded
// only in what we store, every sentence traceable to the items it came from.
//
//   assembleSummaryInput  stored data → numbered items (refs) + prompt text,
//                         newest first, capped by a token budget; anything
//                         older than 90 days (or past the budget) is folded
//                         into one "earlier history" block      (pure, tested)
//   summaryDue            the debounce: lazily on page view when something
//                         changed since the last run, at most once an hour;
//                         manual Refresh skips the hour            (pure, tested)
//   parseSummary          model JSON → sentences whose sources are real refs (pure, tested)
//   generateCompanySummary  claim → load → Claude → store on crm_companies → log
//                         the generation (tokens + cost) in crm_ai_generations.
/* eslint-disable @typescript-eslint/no-explicit-any */

import Anthropic from "@anthropic-ai/sdk";
import { STATUS_LABEL as FEED_STATUS_LABEL, type OrderStatus } from "./feeds/state";
import { STAGE_LABEL, type Stage } from "./format";
import { BILLING_STATE_LABEL, dealerBillingState, type BillingState } from "./billing-status";
import { emailSender, emailTitle } from "./timeline-rows";

export const SUMMARY_MODEL = process.env.CRM_SUMMARY_MODEL || "claude-opus-5-5";
// $ per million tokens [input, output] — for the spend log only.
const PRICE: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-fable-5-1": [10, 50],
};
export const DEBOUNCE_MS = 60 * 60 * 1000;
export const CLAIM_MS = 3 * 60 * 1000;          // an in-flight generation older than this is presumed dead
export const WINDOW_DAYS = 90;
export const ITEM_BUDGET_TOKENS = 12_000;
const BODY_CHARS = 700;

export type RefKind = "activity" | "ticket" | "task" | "feed_order" | "company";
export type Ref = { kind: RefKind; id: string; label: string; at: string | null; who?: string | null };
export type SummarySentence = { text: string; sources: string[] };
export type StoredSummary = { sentences: SummarySentence[]; next_step: SummarySentence | null; refs: Record<string, Ref> };

export type SummaryData = {
  company: { id: string; name: string; kind: string; stage: Stage | null; billing: BillingState | null; trial_day: number | null; trial_ends_on: string | null; trial_flag: string | null; owner: string | null; brands: string[]; city: string | null; state: string | null };
  /** sender: for email, who sent the message (our staff member, or the From name) — never the thread contact. */
  activities: { id: string; type: string; direction: string; subject: string | null; body: string | null; occurred_at: string; created_at: string; actor: string | null; contact: string | null; sender?: string | null }[];
  olderActivities: { type: string; subject: string | null; occurred_at: string }[];
  olderCount: number;
  tickets: { id: string; title: string; status: string; priority: string | null; description: string | null; created_at: string; resolved_at: string | null }[];
  tasks: { id: string; title: string; status: string; description: string | null; due_at: string | null; created_at: string; completed_at: string | null; assignee: string | null }[];
  feedOrders: { id: string; status: string; supplier: string | null; created_at: string; updated_at: string | null; feed_id_confirmed: string | null }[];
};

const est = (s: string) => Math.ceil(s.length / 4);
const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "?");

/** Newest change the summary would cover: activities, tickets, tasks, feed orders. */
export function latestChange(d: Pick<SummaryData, "activities" | "tickets" | "tasks" | "feedOrders">): string | null {
  const ts = [
    ...d.activities.map((a) => a.created_at),
    ...d.tickets.flatMap((t) => [t.created_at, t.resolved_at]),
    ...d.tasks.flatMap((t) => [t.created_at, t.completed_at]),
    ...d.feedOrders.flatMap((o) => [o.created_at, o.updated_at]),
  ].filter((x): x is string => !!x);
  return ts.length ? ts.sort().pop()! : null;
}

export function hasAnyActivity(d: Pick<SummaryData, "activities" | "olderCount" | "tickets" | "tasks" | "feedOrders">): boolean {
  return d.activities.length + d.olderCount + d.tickets.length + d.tasks.length + d.feedOrders.length > 0;
}

/** Stored data → refs + the prompt's data block. Pure. */
export function assembleSummaryInput(d: SummaryData, budgetTokens = ITEM_BUDGET_TOKENS): { text: string; refs: Record<string, Ref>; included: number; folded: number } {
  const refs: Record<string, Ref> = {};
  const lines: string[] = [];
  const c = d.company;
  const stage = c.stage === "paying" ? (c.billing ? BILLING_STATE_LABEL[c.billing] : "Paying customer") : c.stage ? STAGE_LABEL[c.stage] : null;
  refs.C = { kind: "company", id: c.id, label: c.name, at: null };
  lines.push(`[C] Company: ${c.name} (${c.kind})${stage ? ` · stage: ${stage}` : ""}${c.stage === "trial" && c.trial_day != null ? ` · trial day ${c.trial_day}${c.trial_ends_on ? `, ends ${c.trial_ends_on}` : ""}${c.trial_flag ? ` (${c.trial_flag})` : ""}` : ""}${c.owner ? ` · owner: ${c.owner}` : ""}${c.brands.length ? ` · brands: ${c.brands.join(", ")}` : ""}${c.city || c.state ? ` · ${[c.city, c.state].filter(Boolean).join(", ")}` : ""}`);

  let used = est(lines[0]);
  const add = (key: string, ref: Ref, line: string): boolean => {
    const cost = est(line);
    if (used + cost > budgetTokens) return false;
    refs[key] = ref; lines.push(line); used += cost;
    return true;
  };

  // Open work first — it must never be cut for older chatter.
  d.tickets.forEach((t, i) => add(`K${i + 1}`, { kind: "ticket", id: t.id, label: t.title, at: t.created_at },
    `[K${i + 1}] Ticket (${t.status}${t.priority && t.priority !== "normal" ? `, ${t.priority}` : ""}) opened ${day(t.created_at)}${t.resolved_at ? `, resolved ${day(t.resolved_at)}` : ""}: ${clip(t.title, 160)}${t.description ? ` — ${clip(t.description, 300)}` : ""}`));
  d.tasks.forEach((t, i) => add(`T${i + 1}`, { kind: "task", id: t.id, label: t.title, at: t.created_at },
    `[T${i + 1}] Task (${t.status}) created ${day(t.created_at)}${t.due_at ? `, due ${day(t.due_at)}` : ""}${t.assignee ? `, for ${t.assignee}` : ""}: ${clip(t.title, 160)}${t.description ? ` — ${clip(t.description, 300)}` : ""}`));
  d.feedOrders.forEach((o, i) => add(`F${i + 1}`, { kind: "feed_order", id: o.id, label: `Feed order — ${FEED_STATUS_LABEL[o.status as OrderStatus] ?? o.status}`, at: o.created_at },
    `[F${i + 1}] Feed order started ${day(o.created_at)}: ${FEED_STATUS_LABEL[o.status as OrderStatus] ?? o.status}${o.supplier ? ` with ${o.supplier}` : ""}${o.feed_id_confirmed ? `, feed ID ${o.feed_id_confirmed}` : ""}${o.updated_at ? ` (updated ${day(o.updated_at)})` : ""}`));

  let included = 0;
  const overflow: { type: string; subject: string | null; occurred_at: string }[] = [];
  for (const a of d.activities) {        // newest first
    const n = included + 1;
    const who = a.type === "email"
      ? (a.sender ? `from ${a.sender}` : "")
      : [a.actor && `staff ${a.actor}`, a.contact && `contact ${a.contact}`].filter(Boolean).join(", ");
    const label = a.type === "email" ? emailTitle(a.subject, a.body) : a.subject ?? a.type;
    const ok = add(`A${n}`, { kind: "activity", id: a.id, label, at: a.occurred_at, who: a.type === "email" ? a.sender ?? null : a.actor ?? a.contact ?? null },
      `[A${n}] ${day(a.occurred_at)} ${a.type} (${a.direction})${who ? ` [${who}]` : ""}: ${clip(a.subject, 200)}${a.body ? ` — ${clip(a.body, BODY_CHARS)}` : ""}`);
    if (ok) included++; else overflow.push(a);
  }

  const older = [...overflow, ...d.olderActivities];
  const folded = overflow.length + d.olderCount;
  if (folded > 0) {
    const dates = older.map((o) => o.occurred_at).sort();
    const sample = older.slice(0, 25).map((o) => `${day(o.occurred_at)} ${o.type}: ${clip(o.subject, 80)}`).join("; ");
    const line = `[H] Earlier history (${folded} older items${dates.length ? `, ${day(dates[0])} to ${day(dates[dates.length - 1])}` : ""}): ${sample}`;
    refs.H = { kind: "activity", id: "older", label: `${folded} earlier items`, at: dates[0] ?? null };
    lines.push(line);
  }
  return { text: lines.join("\n"), refs, included, folded };
}

/** The debounce. Pure. */
export function summaryDue(
  s: { generated_at: string | null; hwm: string | null; started_at: string | null },
  latest: string | null,
  now: Date,
  manual: boolean,
): { due: boolean; reason: string } {
  if (!latest) return { due: false, reason: "no_activity" };
  if (s.started_at && now.getTime() - Date.parse(s.started_at) < CLAIM_MS) return { due: false, reason: "in_flight" };
  if (manual) return { due: true, reason: "manual" };
  if (!s.generated_at) return { due: true, reason: "first" };
  if (s.hwm && latest <= s.hwm) return { due: false, reason: "up_to_date" };
  if (now.getTime() - Date.parse(s.generated_at) < DEBOUNCE_MS) return { due: false, reason: "debounced" };
  return { due: true, reason: "new_activity" };
}

/** Model output → validated summary (unknown refs dropped; no sentence cap — the card scrolls). Pure. */
export function parseSummary(raw: string, refs: Record<string, Ref>): StoredSummary | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: any;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const clean = (x: any): SummarySentence | null => {
    const text = typeof x?.text === "string" ? x.text.replace(/\s+/g, " ").trim() : "";
    if (!text) return null;
    const sources = Array.isArray(x.sources) ? Array.from(new Set(x.sources.map(String).filter((k: string) => k in refs))) as string[] : [];
    return { text, sources };
  };
  const sentences = (Array.isArray(j.sentences) ? j.sentences : []).map(clean).filter(Boolean) as SummarySentence[];
  if (!sentences.length) return null;
  const used = new Set([...sentences.flatMap((s) => s.sources), ...(clean(j.next_step)?.sources ?? [])]);
  return { sentences, next_step: clean(j.next_step), refs: Object.fromEntries(Object.entries(refs).filter(([k]) => used.has(k))) };
}

const SYSTEM = `You write the "Summary" card on a company record in DA-CRM, the internal CRM of DealerAddendums (window-sticker / addendum software for car dealers). Staff read it to get up to speed before calling or emailing.

Write plain-prose sentences — as many as the record needs, no padding — then one "Next step" sentence. Cover, when the data has it: who they are and where they are in the pipeline or billing; what has been happening recently (calls, emails, chats); open tickets and tasks; any feed order status; the most recent sentiment or friction. If there is earlier history ([H]), give it at most one sentence.

Rules:
- Use ONLY the items provided. Never infer facts, names, numbers, dates or feelings that aren't stated in them. If something isn't in the data, leave it out.
- Each sentence lists the item keys (e.g. "A3", "K1", "C") it is based on in "sources". Every sentence needs at least one source.
- Plain sentences, no bullets, no headings, no markdown. Dates as "Oct 21". Refer to staff by first name.
- The next step is one concrete action for DA staff, grounded in the items (an open task, an unanswered email, a trial ending, a stalled feed order). If nothing calls for action, say so plainly.

Reply with JSON only:
{"sentences":[{"text":"…","sources":["A1"]}],"next_step":{"text":"…","sources":["T1"]}}`;

// ── Loading + generation ─────────────────────────────────────────────────────

export async function loadSummaryData(admin: any, companyId: string, now = new Date()): Promise<SummaryData | null> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86400_000).toISOString();
  const [{ data: dir }, { data: co }] = await Promise.all([
    admin.from("crm_company_directory").select("id, name, kind, pipeline_stage, trial_day, trial_ends_on, trial_flag, owner_staff_id, city, state").eq("id", companyId).maybeSingle(),
    admin.from("crm_companies").select("id, kind, dealer_id").eq("id", companyId).maybeSingle(),
  ]);
  if (!dir || !co) return null;
  const [acts, older, olderCount, tickets, tasks, orders, brands, billing] = await Promise.all([
    admin.from("crm_activities").select("id, type, direction, subject, body, metadata, occurred_at, created_at, actor_staff_id, contact_id")
      .eq("company_id", companyId).gte("occurred_at", since).order("occurred_at", { ascending: false }).limit(200),
    admin.from("crm_activities").select("type, subject, occurred_at").eq("company_id", companyId).lt("occurred_at", since).order("occurred_at", { ascending: false }).limit(25),
    admin.from("crm_activities").select("id", { count: "exact", head: true }).eq("company_id", companyId).lt("occurred_at", since),
    admin.from("crm_tickets").select("id, title, status, priority, description, created_at, resolved_at").eq("company_id", companyId)
      .or(`status.in.(open,pending),created_at.gte.${since}`).order("created_at", { ascending: false }).limit(25),
    admin.from("crm_tasks").select("id, title, status, description, due_at, created_at, completed_at, assigned_staff_id").eq("company_id", companyId)
      .or(`status.eq.open,created_at.gte.${since}`).order("created_at", { ascending: false }).limit(25),
    admin.from("crm_feed_orders").select("id, status, created_at, updated_at, feed_id_confirmed, supplier_company_id").eq("dealer_company_id", companyId).order("created_at", { ascending: false }).limit(5),
    co.kind === "dealer" ? admin.from("crm_company_brands").select("brand").eq("company_id", companyId) : Promise.resolve({ data: [] }),
    co.kind === "dealer" && dir.pipeline_stage === "paying" ? dealerBillingState(admin, co.dealer_id) : Promise.resolve(null),
  ]);
  const staffIds = Array.from(new Set([dir.owner_staff_id, ...(acts.data ?? []).map((a: any) => a.actor_staff_id), ...(tasks.data ?? []).map((t: any) => t.assigned_staff_id)].filter(Boolean)));
  const contactIds = Array.from(new Set((acts.data ?? []).map((a: any) => a.contact_id).filter(Boolean)));
  const supplierIds = Array.from(new Set((orders.data ?? []).map((o: any) => o.supplier_company_id).filter(Boolean)));
  const [staff, contacts, suppliers] = await Promise.all([
    staffIds.length ? admin.from("crm_staff_profiles").select("staff_id, full_name").in("staff_id", staffIds) : Promise.resolve({ data: [] }),
    contactIds.length ? admin.from("crm_contacts").select("id, first_name, last_name, email").in("id", contactIds) : Promise.resolve({ data: [] }),
    supplierIds.length ? admin.from("crm_company_directory").select("id, name").in("id", supplierIds) : Promise.resolve({ data: [] }),
  ]);
  const staffName = Object.fromEntries((staff.data ?? []).map((s: any) => [s.staff_id, s.full_name]));
  const contactName = Object.fromEntries((contacts.data ?? []).map((c: any) => [c.id, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email]));
  const supplierName = Object.fromEntries((suppliers.data ?? []).map((s: any) => [s.id, s.name]));
  return {
    company: {
      id: companyId, name: dir.name ?? "Company", kind: dir.kind, stage: dir.pipeline_stage ?? null, billing: (billing as any)?.state ?? null,
      trial_day: dir.trial_day ?? null, trial_ends_on: dir.trial_ends_on ?? null, trial_flag: dir.trial_flag ?? null,
      owner: dir.owner_staff_id ? staffName[dir.owner_staff_id] ?? null : null,
      brands: (brands.data ?? []).map((b: any) => b.brand).sort(), city: dir.city ?? null, state: dir.state ?? null,
    },
    activities: (acts.data ?? []).map(({ metadata, ...a }: any) => ({ ...a, actor: a.actor_staff_id ? staffName[a.actor_staff_id] ?? null : null, contact: a.contact_id ? contactName[a.contact_id] ?? null : null,
      sender: a.type === "email" ? emailSender({ direction: a.direction, actor_staff_id: a.actor_staff_id, metadata }, staffName) : null })),
    olderActivities: older.data ?? [],
    olderCount: olderCount.count ?? 0,
    tickets: tickets.data ?? [],
    tasks: (tasks.data ?? []).map((t: any) => ({ ...t, assignee: t.assigned_staff_id ? staffName[t.assigned_staff_id] ?? null : null })),
    feedOrders: (orders.data ?? []).map((o: any) => ({ ...o, supplier: o.supplier_company_id ? supplierName[o.supplier_company_id] ?? null : null })),
  };
}

export type SummaryState = {
  summary: StoredSummary | null; generated_at: string | null; hwm: string | null;
  has_activity: boolean; due: boolean; reason: string; error?: string;
};

export async function summaryState(admin: any, companyId: string, now = new Date()): Promise<SummaryState | null> {
  const [{ data: co }, data] = await Promise.all([
    admin.from("crm_companies").select("ai_summary, ai_summary_generated_at, ai_summary_hwm, ai_summary_started_at").eq("id", companyId).maybeSingle(),
    loadSummaryData(admin, companyId, now),
  ]);
  if (!co || !data) return null;
  const latest = latestChange(data);
  const any = hasAnyActivity(data);
  const d = any ? summaryDue({ generated_at: co.ai_summary_generated_at, hwm: co.ai_summary_hwm, started_at: co.ai_summary_started_at }, latest ?? co.ai_summary_hwm ?? "1970-01-01", now, false)
    : { due: false, reason: "no_activity" };
  return { summary: co.ai_summary ?? null, generated_at: co.ai_summary_generated_at, hwm: co.ai_summary_hwm, has_activity: any, ...d };
}

/** Generate (if due, or manual), store and log. Returns the fresh state. */
export async function generateCompanySummary(admin: any, companyId: string, opts: { manual: boolean; staffId: string | null }): Promise<SummaryState & { generated?: boolean }> {
  const now = new Date();
  const [{ data: co }, data] = await Promise.all([
    admin.from("crm_companies").select("ai_summary, ai_summary_generated_at, ai_summary_hwm, ai_summary_started_at").eq("id", companyId).maybeSingle(),
    loadSummaryData(admin, companyId, now),
  ]);
  if (!co || !data) throw new Error("Company not found");
  const base = { summary: co.ai_summary ?? null, generated_at: co.ai_summary_generated_at, hwm: co.ai_summary_hwm };
  if (!hasAnyActivity(data)) return { ...base, has_activity: false, due: false, reason: "no_activity" };
  const latest = latestChange(data) ?? co.ai_summary_hwm ?? now.toISOString();
  const due = summaryDue({ generated_at: co.ai_summary_generated_at, hwm: co.ai_summary_hwm, started_at: co.ai_summary_started_at }, latest, now, opts.manual);
  if (!due.due) return { ...base, has_activity: true, ...due };
  if (!process.env.ANTHROPIC_API_KEY) return { ...base, has_activity: true, due: false, reason: "not_configured", error: "ANTHROPIC_API_KEY not set" };

  // Claim: only one generation per company at a time.
  const stale = new Date(now.getTime() - CLAIM_MS).toISOString();
  const { data: claim } = await admin.from("crm_companies").update({ ai_summary_started_at: now.toISOString() })
    .eq("id", companyId).or(`ai_summary_started_at.is.null,ai_summary_started_at.lt.${stale}`).select("id");
  if (!claim?.length) return { ...base, has_activity: true, due: false, reason: "in_flight" };

  const input = assembleSummaryInput(data);
  const log: Record<string, unknown> = { company_id: companyId, trigger: opts.manual ? "manual" : "auto", staff_id: opts.staffId, model: SUMMARY_MODEL, items: Object.keys(input.refs).length };
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      // Short grounded summarizing — the lowest effort keeps it fast and cheap.
      output_config: { effort: "low" },
      messages: [{ role: "user", content: `Today is ${now.toISOString().slice(0, 10)}.\n\nItems:\n${input.text}` }],
    } as any);
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const inTok = res.usage?.input_tokens ?? 0, outTok = res.usage?.output_tokens ?? 0;
    const [pi, po] = PRICE[SUMMARY_MODEL] ?? [0, 0];
    Object.assign(log, { input_tokens: inTok, output_tokens: outTok, cost_usd: Math.round(((inTok * pi + outTok * po) / 1e6) * 1e5) / 1e5 });
    if (res.stop_reason === "refusal") throw new Error("The model declined to summarize this record");
    const summary = parseSummary(text, input.refs);
    if (!summary) throw new Error("The model's reply wasn't a usable summary");
    const at = new Date().toISOString();
    await admin.from("crm_companies").update({ ai_summary: summary, ai_summary_generated_at: at, ai_summary_hwm: latest, ai_summary_started_at: null }).eq("id", companyId);
    await admin.from("crm_ai_generations").insert(log);
    return { summary, generated_at: at, hwm: latest, has_activity: true, due: false, reason: "generated", generated: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
    await admin.from("crm_companies").update({ ai_summary_started_at: null }).eq("id", companyId);
    await admin.from("crm_ai_generations").insert({ ...log, error: msg });
    return { ...base, has_activity: true, due: false, reason: "error", error: msg };
  }
}
