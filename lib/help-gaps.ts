// Knowledge-gap log: every question Steven couldn't ground in a Help Center
// article, rolled up by question so the team sees what to write next
// (help_knowledge_gaps, migration 169; read on the Help review screen).
//
// Strictly fire-and-forget: logKnowledgeGap() returns immediately, swallows
// every failure, and runs after the reply has been sent — a logging problem
// can never slow or fail a chat.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient, fireWrite } from "@/lib/db";
import { resolveAsker } from "@/lib/help-conversations";

const STOP = new Set(("the and for that this with what how can you your are was does have has from into only "
  + "about there their them then than when where which who why will would could should our out get got any all "
  + "not but use using need want just like make made more some also i do my me is it to a an of in on at be "
  + "please thanks thank hi hello hey").split(" "));

/** Significant words, stemmed + sorted: the roll-up key for "the same question". */
export function gapKey(question: string): string {
  const text = (question || "").toLowerCase()
    .replace(/\bset up\b/g, "setup").replace(/\blog ?in\b/g, "login").replace(/\bsign ?in\b/g, "signin")
    .replace(/\be-?mail\b/g, "email");
  const words = (text.match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
  const key = Array.from(new Set(words)).sort().join(" ");
  return key || (question || "").trim().toLowerCase().slice(0, 200);
}

/** Steven's own words for "my material doesn't cover this". Deliberately
 *  narrow — a false positive just adds a row someone can mark ignored. */
export const UNANSWERED_RE = /\b(don't|do not) have (specific|detailed|any|exact|enough)? ?(details|steps|information|instructions|info)|isn't (covered|in my)|not (covered )?in my (reference|material|notes)|no (article|documentation) (on|about|for)|I'm not sure|I don't know/i;

export type GapReason = "no_article" | "escalated" | "unanswered";

export function logKnowledgeGap(opts: {
  question: string;
  reason: GapReason;
  top: { title: string; score: number } | null;
  conversationId: string | null;
  userId: string | null;
  dealerId: string | null;
  groupId: string | null;
  role: string | null;
}): void {
  void (async () => {
    try {
      const q = (opts.question || "").trim().slice(0, 1000);
      if (!q) return;
      const admin = createAdminSupabaseClient();
      const who = await resolveAsker(admin, { user_id: opts.userId, dealer_id: opts.dealerId, group_id: opts.groupId, role: opts.role });
      const asker = [who.name, who.email && `<${who.email}>`, who.role && `(${who.role})`].filter(Boolean).join(" ") || null;
      fireWrite((admin as any).rpc("log_help_gap", {
        p_key: gapKey(q),
        p_question: q,
        p_reason: opts.reason,
        p_top_article: opts.top?.title ?? null,
        p_top_score: opts.top?.score ?? null,
        p_conversation_id: opts.conversationId,
        p_dealer_id: opts.dealerId,
        p_dealership: who.dealership,
        p_asker: asker,
      }), "help knowledge gap");
    } catch (e) {
      console.error("[help-gaps]", e instanceof Error ? e.message : e);
    }
  })();
}
