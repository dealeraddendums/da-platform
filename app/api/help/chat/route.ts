import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import { buildDealerContext, getRelevantArticles } from "@/lib/help-context";
import { buildSystemPrompt } from "@/lib/help-knowledge";
import { createConversation, ownsConversation, appendMessage, escalateConversation } from "@/lib/help-conversations";

// Sentinel the model appends (own final line) when it can't resolve and the user
// needs a person. Buffered out of the stream (never shown), then triggers escalation.
const ESCALATE_RE = /\n*\[\[ESCALATE\]\]\s*/g;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MODEL = "claude-haiku-4-5-20251001"; // Haiku by default (cost+latency @ ~1,600 dealers)
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

  let body: { messages?: unknown };
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

  // Grounding + own-data-only context (both resolved server-side from claims).
  const [dealerContext, articles] = await Promise.all([
    buildDealerContext(claims),
    getRelevantArticles(lastUser.content),
  ]);
  const system = buildSystemPrompt({ dealerContext, articles }) +
    "\n\nESCALATION: If the user explicitly needs a human, or you genuinely cannot resolve their" +
    " issue from the material above, append the token [[ESCALATE]] on its own final line. The app" +
    " strips it and connects them to a person — do not mention the token itself.";

  // Persist the turn (own-data-only). Reuse the conversation when the client
  // passes one it owns; otherwise start a new one. Snapshot = the context used.
  const reqConvId = typeof (body as { conversationId?: unknown }).conversationId === "string"
    ? (body as { conversationId: string }).conversationId : null;
  let conversationId: string | null = null;
  if (reqConvId && (await ownsConversation(reqConvId, claims))) conversationId = reqConvId;
  if (!conversationId) conversationId = await createConversation(claims, resolveEffectiveDealer(claims), dealerContext);
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
          model: MODEL, max_tokens: MAX_TOKENS, temperature: 0.2, system,
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

        // Persist the assistant answer (sentinel stripped); emit the message id
        // (client parses [[MID:…]] for 👍/👎, then strips it) + an escalation
        // notice + close, before kicking off the (slower) escalation side-effect.
        const escalate = full.includes("[[ESCALATE]]");
        const answer = full.replace(ESCALATE_RE, "").trim();
        const mid = convId ? await appendMessage(convId, "assistant", answer) : null;
        if (escalate) controller.enqueue(encoder.encode("\n\nI've notified our team — someone will follow up by email."));
        if (mid) controller.enqueue(encoder.encode(`\n[[MID:${mid}]]`));
        controller.close();
        if (convId && escalate) void escalateConversation(convId);
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
