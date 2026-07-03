export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "@/lib/auth";

// Generate custom CSS for the Website Integrations "Download Addendum" button
// from a screenshot of the dealer's website, using Claude vision. Auth mirrors
// /api/settings/website-integrations: any authenticated staff role except
// dealer_user (super_admin / group_admin / dealer_admin). No dealer scoping is
// needed — the image never touches dealer data; we only return CSS text.

// Anthropic vision accepts these image media types.
const SUPPORTED_MEDIA = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type SupportedMedia = (typeof SUPPORTED_MEDIA)[number];
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — comfortably under the base64 image limit

const PROMPT = `You are a CSS expert analyzing an automotive dealer website screenshot.

Look at any buttons or call-to-action elements visible on this page. Extract the visual style — colors, font, border-radius, padding, shadow, hover effects.

Generate CSS for a button that visually matches the dealer's website style. The selector is:
  .dealer-addendums__button__download-button

The element is an <a> tag rendered as a button. Include at minimum:
  background-color, color, font-family, font-size, font-weight, padding, border-radius, border, text-decoration, display, cursor

If you can infer a hover state from the design, include a :hover rule too.

Return ONLY valid CSS with no explanation, no markdown fences, no comments. Just the raw CSS rules.`;

const genError = () =>
  NextResponse.json({ error: "Could not generate CSS from this image" }, { status: 400 });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 1. Read the uploaded screenshot from multipart/form-data.
  let file: File | null = null;
  try {
    const form = await req.formData();
    const field = form.get("screenshot");
    if (field instanceof File) file = field;
  } catch {
    return genError();
  }
  if (!file || file.size === 0) return genError();
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large — please upload one under 8 MB." }, { status: 400 });
  }

  const mediaType = file.type as SupportedMedia;
  if (!SUPPORTED_MEDIA.includes(mediaType)) {
    return NextResponse.json({ error: "Unsupported image type — use PNG, JPEG, GIF, or WebP." }, { status: 400 });
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");

  // 2. Ask Claude (vision) to produce matching button CSS.
  let css = "";
  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    css = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.error("generate-css: Anthropic call failed:", e);
    return genError();
  }

  // 3. Strip any stray markdown fences the model may add despite instructions.
  css = css.replace(/^```(?:css)?\s*/i, "").replace(/\s*```$/i, "").trim();

  if (!css) return genError();
  return NextResponse.json({ css });
}
