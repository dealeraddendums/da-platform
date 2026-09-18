import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import Anthropic from "@anthropic-ai/sdk";

// Same infrastructure as the product-description generator
// (/api/ai-content/option-description) — the Anthropic SDK already in the app,
// no new dependency. Sonnet rather than Haiku: this rewrites a whole article and
// has to hold structure, links and embedded media intact, which is a materially
// harder job than writing two sentences about a wheel-lock package.
const MODEL = "claude-sonnet-5";
const MAX_INPUT_CHARS = 20000;

const SYSTEM = `You clean up help-centre articles for DealerAddendums, software that
dealership staff use to design and print vehicle addendums, infosheets and buyer's guides.

Rewrite the article you are given so it is clearer and easier to follow:
- Fix grammar, spelling and punctuation.
- Tighten wording; cut filler. Keep it instructional and plain — you are writing for
  a busy salesperson or office manager, not a developer.
- Prefer numbered steps for a procedure and bullets for a list of options.
- Name UI locations the way the product does (e.g. "My Profile → Billing").

HARD RULES
- PRESERVE THE MEANING. Never add a feature, button, menu, price or policy that is not
  already in the text, and never drop information that is.
- Reproduce every <a>, <img>, <iframe> and <video> tag EXACTLY as given, with the same
  href/src attributes, in the same place in the flow. Do not rewrite, drop or invent URLs.
- Output ONLY these tags: <p> <br> <strong> <em> <u> <h2> <h3> <ul> <ol> <li> <a> <img>
  <iframe> <video>. No <div>, no <span>, no style or class attributes, no <script>.
- Return the HTML and nothing else: no markdown code fences, no preamble, no commentary.`;

/** POST /api/ai-content/help-article — rewrite an article body. super_admin only (the Help CMS). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { html?: string; title?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const html = (body.html ?? "").trim();
  // TipTap hands back "<p></p>" for an empty doc — there is nothing to rewrite.
  if (!html || html.replace(/<[^>]*>/g, "").trim().length < 20) {
    return NextResponse.json({ error: "Write some body text first, then Rewrite it." }, { status: 422 });
  }
  if (html.length > MAX_INPUT_CHARS) {
    return NextResponse.json({ error: "This article is too long to rewrite in one pass." }, { status: 422 });
  }

  const titleNote = body.title?.trim() ? `The article is titled "${body.title.trim()}".\n\n` : "";

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: `${titleNote}Rewrite this article body:\n\n${html}` }],
    });

    const first = message.content[0];
    const text = first && first.type === "text" ? first.text : "";
    const out = stripFences(text).trim();
    if (!out) return NextResponse.json({ error: "The rewrite came back empty — try again." }, { status: 502 });

    // The result goes into the TipTap editor, which parses it against its own
    // schema and silently drops anything it doesn't support, and is then stored
    // verbatim and re-sanitized on every render (lib/help-sanitize) exactly like
    // hand-authored bodies. No separate escaping step here — that is what turned
    // product descriptions into visible literal tags (daacd3c).
    return NextResponse.json({ html: out });
  } catch (err) {
    console.error("[ai-content/help-article] rewrite failed:", err);
    return NextResponse.json({ error: "Couldn't reach the AI service — your text is unchanged." }, { status: 502 });
  }
}

/** Models sometimes wrap HTML in a ```html fence despite being told not to. */
function stripFences(s: string): string {
  const m = s.match(/^\s*```(?:html)?\s*\n([\s\S]*?)\n?\s*```\s*$/i);
  return m ? m[1] : s;
}
