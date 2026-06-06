import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";
import { resolveEffectiveDealer } from "@/lib/dealer-authz";
import { buildDealerContext, getRelevantArticles } from "@/lib/help-context";
import { buildSystemPrompt } from "@/lib/help-knowledge";

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
  const system = buildSystemPrompt({ dealerContext, articles });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const ms = client.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: 0.2, // low — ground, don't improvise
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        for await (const ev of ms) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            controller.enqueue(encoder.encode(ev.delta.text));
          }
        }
        controller.close();
      } catch (err) {
        console.error("[help/chat] stream error:", err instanceof Error ? err.message : err);
        controller.enqueue(encoder.encode("\n\nSorry — I had a problem answering. Please try again, or email support@dealeraddendums.com."));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
