// Second-opinion Feed ID extractor for supplier replies on feeds@. Runs next
// to the regex rules in detect.ts; its answer is only ever a SUGGESTION —
// staff always confirm a Feed ID (Confirm Feed ID), DA-CRM never auto-confirms.
// Off when ANTHROPIC_API_KEY isn't set; any failure (timeout, refusal, bad
// JSON) just means "no suggestion".

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const FEED_ID_MODEL = "claude-opus-5-5";

const ResultSchema = z.object({
  feed_id: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  quote: z.string().nullable(),
});
export type AiFeedId = z.infer<typeof ResultSchema>;

const SYSTEM = `You read emails that inventory-feed suppliers (vAuto, HomeNet, Dealer.com, DMS vendors…) send to DealerAddendums about setting up a dealership's inventory feed.
Find the feed / dealer / store / export ID the supplier assigned or confirmed for the dealership named in the request.
Rules:
- Only an ID the supplier states for THIS dealership. Ignore case numbers, ticket numbers, phone numbers, dates and IDs inside quoted earlier messages.
- If the email asks for approval, asks a question, or doesn't contain the ID, return feed_id null.
- quote: the exact sentence the ID came from (or null).`;

export async function aiExtractFeedId(input: { dealerName: string; supplierName: string | null; subject: string | null; latestText: string }): Promise<AiFeedId | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 });
  try {
    const res = await client.messages.parse({
      model: FEED_ID_MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(ResultSchema) },
      messages: [{
        role: "user",
        content: `Dealership: ${input.dealerName}\nSupplier: ${input.supplierName ?? "unknown"}\nSubject: ${input.subject ?? ""}\n\nNewest message text:\n${input.latestText.slice(0, 12_000)}`,
      }],
    });
    if (res.stop_reason === "refusal") return null;
    const out = res.parsed_output;
    if (!out) return null;
    const id = out.feed_id?.trim() || null;
    return { ...out, feed_id: id && id.length <= 60 ? id : null };
  } catch (e) {
    console.error("[crm-feeds] AI Feed ID extract:", e instanceof Error ? e.message : e);
    return null;
  }
}
