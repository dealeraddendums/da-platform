// Feed-order reply detection — pure rules run on every inbound feeds@ email
// (lib/crm/feeds/inbound.ts applies the result). Tested against sample
// approval and Feed ID emails in scripts/crm-feeds-verify-unit.ts.
//
// Only the NEWEST part of a reply counts. Our request ends with "Reply All
// and write APPROVED", and the quoted history of every reply contains it, so
// quoted text (Outlook's "From:" / "-----Original Message-----" blocks,
// Salesforce's "--------------- Original Message ---------------", "On …
// wrote:", "> " lines) is cut before any phrase or ID is looked for, and so are
// external-sender banners, Safelinks / urldefense-wrapped URLs and signatures.
// Real threads (Team Velocity, vAuto, Autosoft, Oct 2026) are the fixtures in
// scripts/fixtures/crm-feeds/ (test:crm-feed-suppliers).

export const DEFAULT_APPROVAL_PHRASES = ["approved", "approve", "i approve", "approved please proceed", "ok to send", "yes approved", "go ahead", "you have my approval"];

// "not approved", "don't approve", "do not go ahead"… → never an approval.
const NEGATION = /\b(not|don'?t|do\s+not|doesn'?t|cannot|can'?t|won'?t|never|dis|un)\s*(be\s+)?(approve|approved|go\s+ahead|ok)\b|\bdisapprove|\bunapproved|\bhold\s+off|\bdo\s+not\s+proceed/i;

const QUOTE_MARKERS = [
  /-{3,}\s*(original|forwarded) message\s*-{3,}/i,     // also mid-line: "Team Velocity Marketing----- Original Message -----From: …"
  /^\s*_{8,}\s*$/m,
  /^\s*from:\s.+$/im,
  /^\s*on\s.{4,160}\swrote:\s*$/im,
  /^\s*sent from my (iphone|ipad|android|mobile)/im,
  /^\s*-{5,}\s*$/m,
  /^\s*begin forwarded message/im,
];

// Proofpoint puts a one-line preview of the message ABOVE its banner, then the real text after it.
const PROOFPOINT = /^[\s\S]*?ZjQcmQRYFpfptBannerStart[\s\S]*?ZjQcmQRYFpfptBannerEnd/;
// External-sender banners, wherever they sit (Team Velocity's Salesforce box renders as ONE line:
// "EXTERNAL Organization This is an external message sent from outside of our organization").
const BANNER_TEXT = /(external organization\s*)?this is an external (message|email) sent from outside of (our|the) organi[sz]ation\.?|this (message|email) is from an external sender\.?|please use caution (when )?clicking links or opening attachments unless you recognize the sender and (are confident|know) the content is safe\.?/gi;
// …and the short tags that sit on a line of their own.
const BANNER_LINE = /^\s*(\[?external\]?|external organization|external email|caution:.{0,60}(outside|external).*)\s*$/i;
// Rewritten links: Microsoft Safelinks, Proofpoint urldefense, Barracuda linkprotect (bare or in "label (url)" / "<url>$>").
const WRAPPED_URL = /\s*[(<]?https?:\/\/[^\s()<>]*(safelinks\.protection\.outlook\.com|urldefense(\.proofpoint)?\.com|linkprotect\.cudasvc\.com)[^\s()<>]*[)>]?\$?>?/gi;
// A sign-off on its own line ends the message (what follows is the signature).
const SIGN_OFF = /^\s*(--|thank you( and be well)?|thanks( again)?|many thanks|best( regards)?|kind regards|regards|sincerely|cheers|respectfully)[,.!]?\s*$/im;

/** The text the sender actually wrote in this message (quoted history, banners, wrapped links and signature removed). */
export function latestReplyText(text: string | null | undefined): string {
  let t = (text ?? "").replace(/\r\n/g, "\n").replace(/[\u200B-\u200D\uFEFF]/g, "");
  let cut = t.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(t);
    if (m && m.index < cut) cut = m.index;
  }
  t = t.slice(0, cut).replace(PROOFPOINT, "").replace(WRAPPED_URL, "").replace(BANNER_TEXT, "");
  t = t.split("\n").filter((l) => !/^\s*>/.test(l) && !BANNER_LINE.test(l)).join("\n").trim();
  const sig = SIGN_OFF.exec(t);
  if (sig && sig.index > 0) t = t.slice(0, sig.index);
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
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
/** support@x.com's domain also covers mail from salesforce.x.com (Team Velocity's case notices). */
export const domainMatches = (d: string, list: string[]) => list.some((x) => { const y = x.toLowerCase(); return d === y || d.endsWith(`.${y}`); });

export function classifySender(from: string | null, ctx: { approverEmail: string | null; dealerDomains: string[]; supplierEmails: string[]; supplierDomains: string[] }): SenderKind {
  const f = (from ?? "").toLowerCase();
  if (!f) return "other";
  const d = domainOf(f);
  if (ctx.supplierEmails.map((x) => x.toLowerCase()).includes(f)) return "supplier";
  if (ctx.approverEmail && f === ctx.approverEmail.toLowerCase()) return "dealer";
  if (domainMatches(d, ctx.supplierDomains)) return "supplier";
  if (domainMatches(d, ctx.dealerDomains)) return "dealer";
  return "other";
}

// ── Supplier messages ────────────────────────────────────────────────────────

/**
 * What a supplier message without a usable Feed ID is:
 *   approval_request — the supplier runs its own approval loop ("Please REPLY ALL with APPROVED",
 *                      "Kindly reply to this email with 'I approve'"): not a reply to act on
 *   acknowledgement  — case opened / closed notices
 *   completion       — "enabled", "activated", "file setup to go out" → we need the ID, ask a person
 *   other            — anything else (questions, rejections) → a person reviews it
 * Checked approval → completion → acknowledgement: Team Velocity's "set up but disabled until approved"
 * is an approval request; vAuto's "export is enabled … this case is now closed" is a completion.
 */
export type SupplierMessageKind = "approval_request" | "acknowledgement" | "completion" | "other";
const APPROVAL_REQUEST = /reply all with ['"“]?approved|reply to this email with ['"“‘]?i approve|requires? (the )?(dealer|dealership)?\s*\/?\s*(admin )?approval|provide approval|email your approval|(dealer|dealership) approval (is )?required|not received (dealership |dealer )?approval|seeking approval/i;
const ACKNOWLEDGEMENT = /case\s*#?\s*\d+\s+has been (created|opened)|has been (created|opened) to address|we have received your request|opened a ticket|support case\s*#?\s*\d+ has been (opened|closed)|case opened on .* is now resolved|this case is now closed/i;
const COMPLETION = /\b(is|are|been|now) (enabled|activated|active|live)\b|\benabled (this|the) (feed|export)|\benabled under\b|\bhas been activated\b|\bfile (is )?(set ?up|active)\b|\bset ?up to go out\b|\bwill go out\b|\bexports? (is |are )?now enabled/i;

/** `subject` only counts for case notices ("Your vAuto support case #… has been opened"): Team
 *  Velocity's Feed ID reply keeps the subject "Re: DEALER APPROVAL REQUIRED …". */
export function classifySupplierMessage(latest: string, subject: string | null = null): SupplierMessageKind {
  if (APPROVAL_REQUEST.test(latest)) return "approval_request";
  if (COMPLETION.test(latest)) return "completion";
  if (ACKNOWLEDGEMENT.test(latest) || ACKNOWLEDGEMENT.test(subject ?? "")) return "acknowledgement";
  return "other";
}

/** The supplier's case / ticket number: its own pattern (group 1) over subject + newest text. */
export function extractCaseNumber(subject: string | null, latest: string, pattern: string | null | undefined): string | null {
  const re = compilePattern(pattern);
  if (!re) return null;
  for (const m of Array.from(`${subject ?? ""}\n${latest}`.matchAll(re))) {
    const v = (m[1] ?? m[0]).trim();
    if (v) return v;
  }
  return null;
}

// "If we do not receive approval by end of day today, we will cancel this request." (Team Velocity)
// "Please note if approval is not received within 3 Business days, this case will be closed." (vAuto)
export const DEFAULT_CANCELLATION_PATTERNS = [
  "if (we do not|we don't) receive (your |dealer |dealership )?approval[^.!]{0,80}(cancel|close)",
  "if (your |dealer |dealership )?approval is not received[^.!]{0,80}(cancel|close)",
  "without (your |dealer |dealership )?approval[^.!]{0,60}(will|shall) (be )?(cancel|close)",
];

/** The sentence threatening to cancel / close the request for lack of approval, or null. */
export function findCancellationDeadline(latest: string, patterns: string[] = []): string | null {
  const text = latest.replace(/\s+/g, " ");
  for (const p of [...patterns, ...DEFAULT_CANCELLATION_PATTERNS]) {
    const re = compilePattern(p);
    if (!re) continue;
    const m = new RegExp(re.source, "i").exec(text);
    if (!m) continue;
    const start = Math.max(text.lastIndexOf(".", m.index) + 1, text.lastIndexOf("!", m.index) + 1, 0);
    const endDot = text.indexOf(".", m.index + m[0].length);
    return text.slice(start, endDot === -1 ? text.length : endDot + 1).trim();
  }
  return null;
}

export type SupplierSignals = { kind: SupplierMessageKind; caseNumber: string | null; cancellation: string | null };

export type Detection =
  | { kind: "dealer_approved"; latest: string }
  | { kind: "review_dealer_reply"; latest: string }
  | { kind: "feed_id"; candidates: string[]; latest: string; supplier: SupplierSignals }
  | { kind: "supplier_no_id"; latest: string; supplier: SupplierSignals }
  | { kind: "review_reply"; latest: string };

export type OrderMatchContext = {
  status: string; approverEmail: string | null; dealerDomains: string[]; supplierEmails: string[]; supplierDomains: string[];
  feedIdPattern: string | null;
  /** Replies carry no reliable ID (Autosoft): never guess one, a person enters it. */
  feedIdManual?: boolean;
  casePattern?: string | null;
  cancellationPatterns?: string[];
};

/** The rule set for a message ON an order's thread (or matched to an order). */
export function detectOnOrder(
  msg: { from: string | null; text: string | null; subject?: string | null },
  order: OrderMatchContext,
  phrases: string[] = DEFAULT_APPROVAL_PHRASES,
): Detection {
  const latest = latestReplyText(msg.text);
  const who = classifySender(msg.from, order);
  if (who === "supplier") {
    const supplier: SupplierSignals = {
      kind: classifySupplierMessage(latest, msg.subject ?? null),
      caseNumber: extractCaseNumber(msg.subject ?? null, latest, order.casePattern),
      cancellation: findCancellationDeadline(latest, order.cancellationPatterns),
    };
    // While the supplier is still asking for approval, an ID-looking token isn't the feed's ID yet.
    const ids = order.feedIdManual || supplier.kind === "approval_request" ? [] : extractFeedIds(latest, order.feedIdPattern);
    return ids.length ? { kind: "feed_id", candidates: ids, latest, supplier } : { kind: "supplier_no_id", latest, supplier };
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
