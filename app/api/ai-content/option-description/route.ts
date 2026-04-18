import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import Anthropic from "@anthropic-ai/sdk";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  let body: { itemName?: string; price?: string };
  try {
    body = await req.json() as { itemName?: string; price?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const itemName = body.itemName?.trim();
  if (!itemName) {
    return NextResponse.json({ error: "itemName is required" }, { status: 422 });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const priceNote = body.price ? ` (priced at ${body.price})` : "";

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: `Write a 1-2 sentence description for a car dealership addendum option called "${itemName}"${priceNote}. Briefly explain what the product/service is and its key benefit. Be concise, professional, and factual. Return only the description text, no quotes or extra formatting.`,
    }],
  });

  const description = (message.content[0] as { type: string; text: string }).text.trim();
  return NextResponse.json({ description });
}
