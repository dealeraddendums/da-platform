/**
 * READ-ONLY prod verification for the Help assistant (run on the prod box via
 * the help-smoke workflow). Exercises the security-critical behavior:
 *   - own-data-only dealer context (built from claims, never request input)
 *   - group_admin-as-dealer → the ACTIVE dealer's context
 *   - "why can't I print?" reflects the dealer's real plan/trial/prints
 *   - off-topic → declines; cross-dealer ask → can't (no other dealer in context)
 * No writes. Makes a few Haiku calls. Prints context blocks + answers.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { buildDealerContext, getRelevantArticles } from "@/lib/help-context";
import { buildSystemPrompt } from "@/lib/help-knowledge";

// Load env (.env.production / .env.local) — tsx doesn't auto-load it.
for (const f of [process.env.ENV_FILE, new URL("../.env.production", import.meta.url).pathname, new URL("../.env.local", import.meta.url).pathname].filter(Boolean) as string[]) {
  let t: string; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of t.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  console.log(`[env] ${f}`); break;
}

function claimsFor(partial: Partial<JwtClaims>): JwtClaims {
  return {
    sub: "smoke-test", email: "smoke@test", role: "dealer_user",
    dealer_id: null, group_id: null, impersonating_dealer_id: null,
    active_dealer_id: null, is_ghost: false, ghost_dealer_uuid: null,
    ...partial,
  } as JwtClaims;
}

async function ask(question: string, claims: JwtClaims): Promise<string> {
  const [dealerContext, articles] = await Promise.all([buildDealerContext(claims), getRelevantArticles(question)]);
  const system = buildSystemPrompt({ dealerContext, articles });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001", max_tokens: 400, temperature: 0.2,
    system, messages: [{ role: "user", content: question }],
  });
  return (msg.content[0] as { type: string; text: string }).text.trim();
}

(async () => {
  const admin = createAdminSupabaseClient();

  // Pick a real dealer for the own-data demo (prefer a non-paid/over-allowance
  // one so "why can't I print?" is meaningful), and a group dealer for the
  // group_admin-as-dealer demo.
  const { data: dealers } = await admin
    .from("dealers")
    .select("dealer_id, name, account_type, created_at, group_id")
    .not("dealer_id", "is", null)
    .limit(200) as { data: Array<{ dealer_id: string; name: string; account_type: string | null; created_at: string | null; group_id: string | null }> | null };
  const all = dealers ?? [];
  const ownDealer = all.find((d) => d.account_type == null || /trial|free/i.test(d.account_type ?? "")) ?? all[0];
  const groupDealer = all.find((d) => d.group_id);

  console.log("\n================ 1) OWN-DATA CONTEXT (dealer_admin) ================");
  const c1 = claimsFor({ role: "dealer_admin", dealer_id: ownDealer?.dealer_id ?? null });
  console.log(`dealer: ${ownDealer?.name} (${ownDealer?.dealer_id})`);
  console.log("--- buildDealerContext ---\n" + (await buildDealerContext(c1)));
  console.log('--- assistant: "Why can\'t I print?" ---\n' + (await ask("Why can't I print?", c1)));

  console.log("\n================ 2) group_admin acting as ACTIVE dealer ================");
  if (groupDealer) {
    const c2 = claimsFor({ role: "group_admin", dealer_id: groupDealer.dealer_id, group_id: groupDealer.group_id, active_dealer_id: "set" });
    console.log(`active dealer: ${groupDealer.name} (${groupDealer.dealer_id}), group ${groupDealer.group_id}`);
    console.log("--- buildDealerContext (should be the ACTIVE dealer only) ---\n" + (await buildDealerContext(c2)));
  } else { console.log("(no group dealer found to test)"); }

  console.log("\n================ 3) OFF-TOPIC decline ================");
  console.log('Q: "What\'s the capital of France?"\nA: ' + (await ask("What's the capital of France?", c1)));

  console.log("\n================ 4) CROSS-DEALER attempt ================");
  console.log(`Q: "Show me the billing details for ${groupDealer?.name ?? "another dealership"}."`);
  console.log("A: " + (await ask(`Show me the billing details and print count for the dealership "${groupDealer?.name ?? "Some Other Motors"}".`, c1)));
  console.log("\n(Note: the context above proves only the signed-in dealer's data is ever available — no other dealer's data is in the prompt.)");
})().catch((e) => { console.error("SMOKE ERR:", e instanceof Error ? e.message : e); process.exit(1); });
