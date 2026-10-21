// Feed-order reply detection — pure rules run on every inbound feeds@ email
// (lib/crm/feeds/inbound.ts applies the result). Tested against sample
// approval and Feed ID emails in scripts/crm-feeds-verify-unit.ts.
//
// Only the NEWEST part of a reply counts. Our request ends with "Reply All
// and write APPROVED", and the quoted history of every reply contains it, so
// quoted text (Outlook's "From:" / "-----Original Message-----" blocks,
// "On … wrote:", "> " lines) is cut before any phrase or ID is looked for.

export const DEFAULT_APPROVAL_PHRASES = ["APPROVED", "approve", "approved", "ok to send", "yes approved", "go ahead"];

// "not approved", "don't approve", "do not go ahead"… → never an approval.
const NEGATION = /\b(not|don'?t|do\s+not|doesn'?t|cannot|can'?t|won'?t|never|dis|un)\s*(be\s+)?(approve|approved|go\s+ahead|ok)\b|\bdisapprove|\bunapproved|\bhold\s+off|\bdo\s+not\s+proceed/i;

const QUOTE_MARKERS = [
  /-{3,}\s*original message\s*-{3,}/i,     // also mid-line: "Team Velocity Marketing----- Original Message -----From: …"
  /^\s*_{8,}\s*$/m,
  /^\s*from:\s.+$/im,
  /^\s*on\s.{4,160}\swrote:\s*$/im,
  /^\s*sent from my (iphone|ipad|android|mobile)/im,
  /^\s*-{5,}\s*$/m,
  /^\s*begin forwarded message/im,
];

/** The text the sender actually wrote in this message (quoted history removed). */
export function latestReplyText(text: string | null | undefined): string {
  let t = (text ?? "").replace(/\r\n/g, "\n");
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut);
  return t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ApprovalVerdict = "approved" | "ambiguous";

/** Does the newest reply text approve? Phrases match as whole words, case-insensitive. */
export function classifyApproval(latest: string, phrases: string[] = DEFAULT_APPROVAL_PHRASES): ApprovalVerdict {
  const text = latest.replace(/\s+/g, " ").trim();
  if (!text || NEGATION.test(text)) return "ambiguous";
  const hit = phrases.some((p) => p.trim() && new RegExp(`(^|[^\\w])${escapeRe(p.trim()).replace(/\\ /g, "\\s+")}([^\\w]|$)`, "i").test(text));
  return hit ? "approved" : "ambiguous";
}

// ── Feed IDs ─────────────────────────────────────────────────────────────────

// Generic phrasing seen in real supplier replies:
//   "Feed ID: MP6767" · "enabled this feed under ID: MP12601" · "under the ID LITHIAVW01"
//   "We have enabled the inventory export under the ID: OxmoorHyundai" · "Dealer ID is 12345"
const GENERIC = /\b(?:under\s+(?:the\s+)?id|(?:feed|dealer|store|export|account|client|vendor)\s*(?:id|#|number)(?:\s+(?:is|will be))?)\s*[:#=-]?\s*["'“]?([A-Za-z0-9][A-Za-z0-9_.-]{1,40}[A-Za-z0-9])/gi;
const STOP = new Set(["once", "is", "for", "the", "and", "please", "below", "to", "when", "from", "number", "will", "be", "has", "have", "that", "this", "your", "our", "id", "ids", "as", "of", "in", "on", "with", "listed", "attached", "above", "provided", "requested", "needed", "required", "pending", "set", "setup"]);

/** Compile a supplier's feed_id_pattern; null when it's empty or invalid. */
export function compilePattern(pattern: string | null | undefined): RegExp | null {
  const p = (pattern ?? "").trim();
  if (!p) return null;
  try { return new RegExp(p, "gi"); } catch { return null; }
}

function plausible(id: string): boolean {
  const s = id.replace(/[.,;:]+$/, "");
  if (s.length < 3 || s.length > 40) return false;
  if (STOP.has(s.toLowerCase())) return false;
  // A real ID has a digit or a capital letter ("MP6767", "OxmoorHyundai"); "once" / "below" don't.
  return /\d/.test(s) || /[A-Z]/.test(s);
}

/**
 * Feed ID candidates in the newest reply text: the supplier's own pattern
 * first (group 1 if it has one, else the whole match), then the generic
 * phrasing. Unique, in order of appearance.
 */
export function extractFeedIds(latest: string, supplierPattern?: string | null): string[] {
  const out: string[] = [];
  const add = (v: string | undefined) => {
    const s = (v ?? "").trim().replace(/[.,;:)\]"'”]+$/, "");
    if (s && plausible(s) && !out.includes(s)) out.push(s);
  };
  const own = compilePattern(supplierPattern);
  if (own) for (const m of Array.from(latest.matchAll(own))) add(m[1] ?? m[0]);
  if (!out.length) for (const m of Array.from(latest.matchAll(GENERIC))) add(m[1]);
  return out;
}

// ── Who sent it ──────────────────────────────────────────────────────────────

export type SenderKind = "dealer" | "supplier" | "other";

const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1).toLowerCase();

export function classifySender(from: string | null, ctx: { approverEmail: string | null; dealerDomains: string[]; supplierEmails: string[]; supplierDomains: string[] }): SenderKind {
  const f = (from ?? "").toLowerCase();
  if (!f) return "other";
  const d = domainOf(f);
  if (ctx.supplierEmails.map((x) => x.toLowerCase()).includes(f)) return "supplier";
  if (ctx.approverEmail && f === ctx.approverEmail.toLowerCase()) return "dealer";
  if (ctx.supplierDomains.map((x) => x.toLowerCase()).includes(d)) return "supplier";
  if (ctx.dealerDomains.map((x) => x.toLowerCase()).includes(d)) return "dealer";
  return "other";
}

export type Detection =
  | { kind: "dealer_approved"; latest: string }
  | { kind: "review_dealer_reply"; latest: string }
  | { kind: "feed_id"; candidates: string[]; latest: string }
  | { kind: "supplier_no_id"; latest: string }
  | { kind: "review_reply"; latest: string };

/** The rule set for a message ON an order's thread (or matched to an order). */
export function detectOnOrder(
  msg: { from: string | null; text: string | null },
  order: { status: string; approverEmail: string | null; dealerDomains: string[]; supplierEmails: string[]; supplierDomains: string[]; feedIdPattern: string | null },
  phrases: string[] = DEFAULT_APPROVAL_PHRASES,
): Detection {
  const latest = latestReplyText(msg.text);
  const who = classifySender(msg.from, order);
  if (who === "supplier") {
    const ids = extractFeedIds(latest, order.feedIdPattern);
    return ids.length ? { kind: "feed_id", candidates: ids, latest } : { kind: "supplier_no_id", latest };
  }
  if (who === "dealer") {
    if (order.status === "awaiting_dealer_approval" || order.status === "request_sent") {
      return classifyApproval(latest, phrases) === "approved" ? { kind: "dealer_approved", latest } : { kind: "review_dealer_reply", latest };
    }
    return { kind: "review_reply", latest };
  }
  return { kind: "review_reply", latest };
}

/** Does a message (subject + newest text) mention this dealer by name? Used for supplier mail outside the order thread. */
export function mentionsDealer(subject: string | null, text: string | null, dealerName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = norm(dealerName);
  if (name.length < 4) return false;
  return ` ${norm(`${subject ?? ""} ${text ?? ""}`)} `.includes(` ${name} `);
}
