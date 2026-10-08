import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import { buildDealerContext, getRelevantArticlesScored } from "@/lib/help-context";
import { logKnowledgeGap, UNANSWERED_RE } from "@/lib/help-gaps";
import { buildSystemPrompt } from "@/lib/help-knowledge";
import { createConversation, ownsConversation, appendMessage, escalateConversation, resolveAsker } from "@/lib/help-conversations";
import { createAdminSupabaseClient } from "@/lib/db";
import { publishToInbox } from "@/lib/help-handoff";

// Sentinel the model appends (own final line) when it can't resolve and the user
// needs a person. Buffered out of the stream (never shown), then triggers escalation.
const ESCALATE_RE = /\n*\[\[ESCALATE\]\]\s*/g;

// Only a dealer who ASKED for a person is connected automatically. When Steven
// merely can't answer, it offers the "Talk to a person" button instead —
// otherwise every gap in the Help Center would page the support team live.
const WANTS_HUMAN = /\b(real person|human|a person|someone|support (team|rep|agent)|agent|representative|rep\b|call me|phone call|talk to (you|support|sales|somebody)|speak (to|with))\b/i;

export const dynamic = "force-dynamic";
// Live-chat state is read on every message; never serve a cached read.
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

// Same model as the homepage Steven (da-marketing-os lib/ai.ts MODEL) so both
// surfaces answer at the same quality. Overridable without a deploy.
const MODEL = process.env.HELP_AI_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 700;
const MAX_HISTORY = 12;        // cap conversation turns sent to the model
const MAX_MSG_CHARS = 4000;    // cap per-message length
const RATE_MAX = 20;           // requests
const RATE_WINDOW_MS = 60_000; // per minute, per dealer/user

// In-memory limiter (pm2 runs a single instance). Keyed by effective dealer, or
// user id when no dealer is in context.
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) { buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS }); return false; }
  if (b.count >= RATE_MAX) return true;
  b.count++;
  return false;
}

type ChatMsg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest): Promise<Response> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const rateKey = resolveEffectiveDealer(claims) ?? `user:${claims.sub}`;
  if (rateLimited(rateKey)) {
    return Response.json({ error: "You're sending messages too quickly — please wait a moment." }, { status: 429 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: "The help assistant is not configured. Please contact support@dealeraddendums.com." }, { status: 503 });
  }

  let body: { messages?: unknown; page?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  // Sanitize + cap history; keep only user/assistant turns, last MAX_HISTORY.
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMsg[] = raw
    .filter((m): m is ChatMsg =>
      !!m && typeof (m as ChatMsg).content === "string" &&
      ((m as ChatMsg).role === "user" || (m as ChatMsg).role === "assistant"))
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }))
    .slice(-MAX_HISTORY);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.content.trim()) {
    return Response.json({ error: "Ask a question to get started." }, { status: 400 });
  }

  // Page the dealer is on — context for the answer, never trusted for access.
  const page = typeof body.page === "string" ? body.page.slice(0, 300) : null;

  // ── A person has this conversation: Steven stays quiet ──────────────────
  // The message goes to the agent in the HubSpot inbox instead of the model;
  // X-Help-Live tells the bubble it's talking to a person (and from when).
  const reqConvIdEarly = typeof (body as { conversationId?: unknown }).conversationId === "string"
    ? (body as { conversationId: string }).conversationId : null;
  if (reqConvIdEarly && (await ownsConversation(reqConvIdEarly, claims))) {
    const admin = createAdminSupabaseClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: conv } = await (admin as any).from("help_conversations")
      .select("id, user_id, dealer_id, group_id, role, handoff_provider, live_at").eq("id", reqConvIdEarly).maybeSingle();
    if (conv?.handoff_provider === "hubspot" && conv.live_at) {
      const mid = await appendMessage(conv.id, "user", lastUser.content);
      const who = await resolveAsker(admin, conv);
      await publishToInbox({ conversationId: conv.id, idempotencyId: mid ?? `${conv.id}:${Date.now()}`, text: lastUser.content, who, userId: conv.user_id });
      return new Response("", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
          "X-Conversation-Id": conv.id, "X-Help-Live": "1",
          "X-Help-Live-At": new Date(new Date(conv.live_at).getTime() - 1000).toISOString(),
        },
      });
    }
  }

  // Grounding + own-data-only context (both resolved server-side from claims).
  const [dealerContext, retrieval] = await Promise.all([
    buildDealerContext(claims),
    getRelevantArticlesScored(lastUser.content),
  ]);
  const articles = retrieval.articles;
  const system = buildSystemPrompt({ dealerContext, articles }) +
    (page ? `\n\nThe user is currently on this page of the app: ${page}` : "") +
    "\n\nESCALATION: If the user explicitly needs a human, or you genuinely cannot resolve their" +
    " issue from the material above, append the token [[ESCALATE]] on its own final line. The app" +
    " strips it and connects them to a person — do not mention the token itself.";

  // Persist the turn (own-data-only). Reuse the conversation when the client
  // passes one it owns; otherwise start a new one. Snapshot = the context used.
  const reqConvId = typeof (body as { conversationId?: unknown }).conversationId === "string"
    ? (body as { conversationId: string }).conversationId : null;
  let conversationId: string | null = null;
  if (reqConvId && (await ownsConversation(reqConvId, claims))) conversationId = reqConvId;
  if (!conversationId) conversationId = await createConversation(claims, resolveEffectiveDealer(claims), dealerContext, page);
  if (conversationId) await appendMessage(conversationId, "user", lastUser.content);
  const convId = conversationId;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();
  const TAIL = 16; // hold back enough trailing chars to catch/strip the sentinel before flushing

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      let flushed = 0;
      try {
        const ms = client.messages.stream({
          // No `temperature`: Sonnet 5 rejects it ("deprecated for this model").
          model: MODEL, max_tokens: MAX_TOKENS, system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        for await (const ev of ms) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            full += ev.delta.text;
            const safe = full.length - TAIL;          // withhold the tail (may contain the sentinel)
            if (safe > flushed) { controller.enqueue(encoder.encode(full.slice(flushed, safe))); flushed = safe; }
          }
        }
        // Flush the remaining tail with the sentinel removed.
        const tailOut = full.slice(flushed).replace(ESCALATE_RE, "");
        if (tailOut) controller.enqueue(encoder.encode(tailOut));

        // Persist the assistant answer (sentinel stripped). Trailing control
        // markers the client consumes and never shows: [[MID:…]] (👍/👎) and,
        // when the hand-off went live, [[LIVE:<cursor>]] (switch to live mode).
        const escalate = full.includes("[[ESCALATE]]") && WANTS_HUMAN.test(lastUser.content);
        const offerPerson = full.includes("[[ESCALATE]]") && !escalate;
        const answer = full.replace(ESCALATE_RE, "").trim();
        const mid = convId ? await appendMessage(convId, "assistant", answer) : null;
        if (convId && escalate) {
          const esc = await escalateConversation(convId);
          controller.enqueue(encoder.encode(esc.live
            ? "\n\nI'm connecting you with our support team now — someone will reply right here."
            : "\n\nI've notified our team — someone will follow up by email."));
          if (mid) controller.enqueue(encoder.encode(`\n[[MID:${mid}]]`));
          if (esc.live && esc.at) controller.enqueue(encoder.encode(`\n[[LIVE:${esc.at}]]`));
        } else {
          if (offerPerson) controller.enqueue(encoder.encode("\n\nIf you'd like a person to help, tap **Talk to a person** below."));
          if (mid) controller.enqueue(encoder.encode(`\n[[MID:${mid}]]`));
        }
        controller.close();

        // Knowledge-gap log (after the reply is out; fire-and-forget).
        const sentinel = full.includes("[[ESCALATE]]");
        const gapReason = !retrieval.matched ? "no_article"
          : sentinel ? "escalated"
          : UNANSWERED_RE.test(answer) ? "unanswered" : null;
        if (gapReason) {
          logKnowledgeGap({
            question: lastUser.content, reason: gapReason, top: retrieval.top, conversationId: convId,
            userId: claims.sub, dealerId: resolveEffectiveDealer(claims), groupId: claims.group_id ?? null, role: claims.role,
          });
        }
      } catch (err) {
        console.error("[help/chat] stream error:", err instanceof Error ? err.message : err);
        controller.enqueue(encoder.encode("\n\nSorry — I had a problem answering. Please try again, or email support@dealeraddendums.com."));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no",
      ...(convId ? { "X-Conversation-Id": convId } : {}),
    },
  });
}
