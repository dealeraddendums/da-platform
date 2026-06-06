/**
 * Help/Support — PROD smoke verification (run on the prod box via the
 * help-verify workflow). Asserts behavior that needs the live env/DB/Claude/
 * HubSpot but NO browser session. Operates on a QA/test dealer ONLY.
 *
 * Checks (docs/help-support-widget.md):
 *   Chat #1  "why can't I print?" → references the QA dealer's own plan/print status
 *   Chat #2  off-topic question   → declined (does NOT answer it)
 *   HubSpot #5  close → one note (capture id); reopen + message + close → SAME
 *               note id, body updated, no second note. Cleans up after itself.
 *
 * SAFETY: every dealer context is built from synthesized claims for the QA dealer
 * (own-data-only, never a real dealer). Before any HubSpot write we assert the QA
 * user's profile points at the TEST contact — we never write to a real contact.
 *
 * Required env (set by the workflow from its inputs):
 *   QA_DEALER_ID, QA_USER_ID, QA_TEST_HUBSPOT_CONTACT_ID
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { buildDealerContext, getRelevantArticles } from "@/lib/help-context";
import { buildSystemPrompt } from "@/lib/help-knowledge";
import { hubspotConfigured } from "@/lib/hubspot";
import { createConversation, appendMessage, logConversationToHubspot } from "@/lib/help-conversations";

// Load env (.env.production / .env.local) — tsx doesn't auto-load it.
for (const f of [process.env.ENV_FILE, new URL("../.env.production", import.meta.url).pathname, new URL("../.env.local", import.meta.url).pathname].filter(Boolean) as string[]) {
  let t: string; try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of t.split("\n")) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
  console.log(`[env] ${f}`); break;
}

const HUBSPOT_BASE = "https://api.hubapi.com/crm/v3";
const results: { name: string; state: "PASS" | "FAIL" | "SKIP"; detail?: string }[] = [];
function record(name: string, state: "PASS" | "FAIL" | "SKIP", detail?: string) { results.push({ name, state, detail }); }
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); record(name, "PASS"); } catch (e) { record(name, "FAIL", e instanceof Error ? e.message : String(e)); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

function claimsFor(p: Partial<JwtClaims>): JwtClaims {
  return {
    sub: "smoke", email: "smoke@test", role: "dealer_user",
    dealer_id: null, group_id: null, impersonating_dealer_id: null,
    active_dealer_id: null, is_ghost: false, ghost_dealer_uuid: null, ...p,
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

async function hubspotGetNoteBody(noteId: string): Promise<string> {
  const res = await fetch(`${HUBSPOT_BASE}/objects/notes/${encodeURIComponent(noteId)}?properties=hs_note_body`, {
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` },
  });
  if (!res.ok) throw new Error(`get note ${noteId} → ${res.status}`);
  return ((await res.json()) as { properties?: { hs_note_body?: string } }).properties?.hs_note_body ?? "";
}
async function hubspotDeleteNote(noteId: string): Promise<void> {
  await fetch(`${HUBSPOT_BASE}/objects/notes/${encodeURIComponent(noteId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${process.env.HUBSPOT_PRIVATE_APP_TOKEN}` },
  }).catch(() => {});
}

(async () => {
  const admin = createAdminSupabaseClient();
  const QA_DEALER_ID = process.env.QA_DEALER_ID;
  const QA_USER_ID = process.env.QA_USER_ID;
  const QA_TEST_CONTACT = process.env.QA_TEST_HUBSPOT_CONTACT_ID;

  // ── Chat #1 / #2 (need QA_DEALER_ID) ──────────────────────────────────────
  if (!QA_DEALER_ID) {
    record("Chat #1: own plan/print status", "SKIP", "QA_DEALER_ID not set");
    record("Chat #2: off-topic declined", "SKIP", "QA_DEALER_ID not set");
  } else {
    const qaClaims = claimsFor({ role: "dealer_admin", dealer_id: QA_DEALER_ID, sub: QA_USER_ID ?? "smoke" });
    const ctx = await buildDealerContext(qaClaims);
    console.log(`\n[QA dealer ${QA_DEALER_ID}] context:\n${ctx}\n`);

    await check("Chat #1: 'why can't I print?' references own plan/print status", async () => {
      const a = await ask("Why can't I print?", qaClaims);
      console.log(`Q: Why can't I print?\nA: ${a}\n`);
      assert(/print|plan|trial|billing|upgrade|subscription/i.test(a), `answer did not reference plan/print status: ${a.slice(0, 160)}`);
    });

    await check("Chat #2: off-topic question is declined", async () => {
      const a = await ask("What's the capital of France?", qaClaims);
      console.log(`Q: What's the capital of France?\nA: ${a}\n`);
      assert(!/paris/i.test(a), `assistant answered the off-topic question: ${a.slice(0, 160)}`);
    });
  }

  // ── HubSpot #5 upsert (need QA_USER_ID + QA_TEST_CONTACT + token) ──────────
  const canHubspot = QA_USER_ID && QA_TEST_CONTACT && QA_DEALER_ID && hubspotConfigured();
  if (!canHubspot) {
    record("HubSpot #5: one note, upserted on reopen", "SKIP", "QA_USER_ID / QA_TEST_HUBSPOT_CONTACT_ID / token missing");
  } else {
    // SAFETY GATE: the QA user must already point at the TEST contact, else abort
    // before any write so we can never touch a real dealer's HubSpot record.
    const { data: profile } = await admin.from("profiles").select("hubspot_contact_id").eq("id", QA_USER_ID).maybeSingle<{ hubspot_contact_id: string | null }>();
    if (!profile || profile.hubspot_contact_id !== QA_TEST_CONTACT) {
      record("HubSpot #5: one note, upserted on reopen", "FAIL",
        `SAFETY ABORT: QA user ${QA_USER_ID} profile.hubspot_contact_id=${profile?.hubspot_contact_id ?? "null"} ≠ test contact ${QA_TEST_CONTACT}. Refusing to write.`);
    } else {
      let convId: string | null = null;
      let noteId1 = "";
      try {
        await check("HubSpot #5: create → one note; reopen + message → SAME note, body updated", async () => {
          const qaClaims = claimsFor({ role: "dealer_admin", dealer_id: QA_DEALER_ID, sub: QA_USER_ID });
          convId = await createConversation(qaClaims, QA_DEALER_ID, "QA smoke context");
          assert(convId, "createConversation returned null (is migration 092 applied?)");
          await appendMessage(convId!, "user", "QA smoke: how do I print labels?");
          await appendMessage(convId!, "assistant", "QA smoke ANSWER ONE.");

          // First close → creates the note.
          await logConversationToHubspot(convId!);
          const { data: c1 } = await admin.from("help_conversations" as never).select("hubspot_note_id, hubspot_logged_at").eq("id", convId!).maybeSingle<{ hubspot_note_id: string | null; hubspot_logged_at: string | null }>();
          noteId1 = c1?.hubspot_note_id ?? "";
          assert(noteId1, "no hubspot_note_id after first close");
          const body1 = await hubspotGetNoteBody(noteId1);
          assert(/QA smoke ANSWER ONE/.test(body1), "note body missing first answer");

          // Reopen + new message + close again → MUST reuse the same note, updated.
          await appendMessage(convId!, "user", "QA smoke FOLLOW-UP TWO.");
          await logConversationToHubspot(convId!);
          const { data: c2 } = await admin.from("help_conversations" as never).select("hubspot_note_id").eq("id", convId!).maybeSingle<{ hubspot_note_id: string | null }>();
          assert(c2?.hubspot_note_id === noteId1, `second close created a DIFFERENT note (${c2?.hubspot_note_id}) — expected ${noteId1}`);
          const body2 = await hubspotGetNoteBody(noteId1);
          assert(/QA smoke FOLLOW-UP TWO/.test(body2), "note body was not updated with the follow-up");
        });
      } finally {
        // Cleanup: delete the test note + conversation (messages cascade).
        if (noteId1) await hubspotDeleteNote(noteId1);
        if (convId) await admin.from("help_conversations" as never).delete().eq("id", convId);
        console.log(`[cleanup] removed test note ${noteId1 || "(none)"} + conversation ${convId || "(none)"}`);
      }
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  console.log("\n===== HELP/SUPPORT PROD SMOKE =====");
  let failed = 0;
  for (const r of results) {
    console.log(`${r.state}  ${r.name}${r.detail ? `\n        ↳ ${r.detail}` : ""}`);
    if (r.state === "FAIL") failed++;
  }
  const passed = results.filter((r) => r.state === "PASS").length;
  const skipped = results.filter((r) => r.state === "SKIP").length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("SMOKE HARNESS ERROR:", e instanceof Error ? e.stack : e); process.exit(1); });
