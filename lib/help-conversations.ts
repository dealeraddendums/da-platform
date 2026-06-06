// Help/Support conversation persistence, escalation, and HubSpot logging.
//
// SECURITY: a conversation is bound to one user + their effective dealer; the
// stored context snapshot is the SAME own-data-only block the assistant used
// (see lib/help-context). No card/PII/cross-dealer is ever written here or to
// HubSpot. The AI is read-only; humans take actions.
//
// help_conversations / help_messages aren't in the generated Database type yet
// (migration 092) — use the loosely-typed client, matching the codebase convention.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { JwtClaims } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { sendMandrillEmail } from "@/lib/mandrill";
import { hubspotConfigured, createConversationNote, updateConversationNote } from "@/lib/hubspot";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
const SUPPORT_EMAIL = "support@dealeraddendums.com";

/** Create a conversation row; returns its id. */
export async function createConversation(claims: JwtClaims, dealerId: string | null, contextSnapshot: string): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any)
    .from("help_conversations")
    .insert({ user_id: claims.sub, dealer_id: dealerId, role: claims.role, group_id: claims.group_id, context_snapshot: contextSnapshot })
    .select("id").single();
  return data?.id ?? null;
}

/** Confirm a conversation belongs to this user (own-data guard for follow-ups). */
export async function ownsConversation(conversationId: string, claims: JwtClaims): Promise<boolean> {
  if (claims.role === "super_admin") return true;
  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any).from("help_conversations").select("user_id").eq("id", conversationId).maybeSingle();
  return !!data && data.user_id === claims.sub;
}

export async function appendMessage(conversationId: string, role: "user" | "assistant" | "agent", content: string): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any)
    .from("help_messages").insert({ conversation_id: conversationId, role, content }).select("id").single();
  await (admin as any).from("help_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);
  return data?.id ?? null;
}

/** 👍/👎 on an assistant answer; a 👎 flags the conversation for review. */
export async function setFeedback(messageId: string, value: "up" | "down"): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: msg } = await (admin as any).from("help_messages").update({ feedback: value }).eq("id", messageId).select("conversation_id").single();
  if (value === "down" && msg?.conversation_id) {
    await (admin as any).from("help_conversations").update({ flagged: true }).eq("id", msg.conversation_id);
  }
}

/**
 * Escalate to a human (async, Phase A): mark escalated and — once per escalation
 * (debounced via escalation_notified_at) — Mandrill-notify support with the
 * dealer context + a deep link to the review surface.
 */
export async function escalateConversation(conversationId: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: conv } = await (admin as any)
    .from("help_conversations")
    .select("id, dealer_id, role, context_snapshot, status, escalation_notified_at")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return;

  await (admin as any).from("help_conversations")
    .update({ status: "escalated", escalated_at: new Date().toISOString() })
    .eq("id", conversationId);

  if (conv.escalation_notified_at) return; // already notified — debounce

  // Last few turns for context in the email.
  const { data: msgs } = await (admin as any)
    .from("help_messages").select("role, content, created_at").eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const transcript = (msgs ?? []).slice(-8).map((m: any) => `<p><strong>${m.role}:</strong> ${escapeHtml(m.content).slice(0, 1200)}</p>`).join("");
  const link = `${APP_URL}/help/manage?tab=conversations&id=${conversationId}`;

  try {
    await sendMandrillEmail({
      subject: `Help escalation — dealer needs a person`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Help",
      to: [{ email: SUPPORT_EMAIL, name: "DA Support", type: "to" }],
      html:
        `<p>A dealer asked for a person (or the assistant couldn't resolve it).</p>` +
        `<p><strong>Review &amp; reply:</strong> <a href="${link}">${link}</a></p>` +
        `<h4>Dealer context</h4><pre style="white-space:pre-wrap">${escapeHtml(conv.context_snapshot ?? "")}</pre>` +
        `<h4>Recent conversation</h4>${transcript}`,
    });
    await (admin as any).from("help_conversations").update({ escalation_notified_at: new Date().toISOString() }).eq("id", conversationId);
  } catch (err) {
    console.error("[help] escalation notify failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * On CLOSE/RESOLVE: upsert ONE full-transcript note to the user's HubSpot
 * Contact (associated to the dealership Company). One note per conversation —
 * created on the first close, then UPDATED on later closes/resolve so a
 * reopen-and-continue is captured without spawning a second note. Skips when
 * nothing new has been said since the last sync. Async/fire-and-forget — never
 * blocks or throws to the caller. Failures → hubspot_sync_errors. Not per-message.
 */
export async function logConversationToHubspot(conversationId: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  try {
    const { data: conv } = await (admin as any)
      .from("help_conversations")
      .select("id, user_id, dealer_id, status, context_snapshot, hubspot_logged_at, hubspot_note_id")
      .eq("id", conversationId).maybeSingle();
    if (!conv) return;
    if (!hubspotConfigured()) return;

    const { data: msgs } = await (admin as any)
      .from("help_messages").select("role, content, created_at").eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (!msgs || msgs.length === 0) return;               // nothing to log

    // Skip a redundant write: already synced and no newer message since.
    const latestMsgAt = (msgs as any[]).reduce((acc: string, m: any) => (m.created_at > acc ? m.created_at : acc), "");
    if (conv.hubspot_note_id && conv.hubspot_logged_at && conv.hubspot_logged_at >= latestMsgAt) return;

    // Resolve the HubSpot Contact (user) + Company (dealership) ids.
    const { data: profile } = await admin.from("profiles").select("hubspot_contact_id, full_name, email").eq("id", conv.user_id).maybeSingle();
    const contactId = profile?.hubspot_contact_id ?? null;
    if (!contactId) return;                               // no contact to attach to yet — try again on a later close
    let companyId: string | null = null;
    if (conv.dealer_id) {
      const { data: dealer } = await admin.from("dealers").select("hubspot_company_id").eq("dealer_id", conv.dealer_id).maybeSingle();
      companyId = dealer?.hubspot_company_id ?? null;
    }

    const body =
      `<p><strong>DA Help conversation</strong> (${conv.status})</p>` +
      `<p><em>${escapeHtml(conv.context_snapshot ?? "").replace(/\n/g, "<br>")}</em></p>` +
      (msgs as any[]).map((m) => `<p><strong>${m.role === "assistant" ? "Assistant" : m.role === "agent" ? "Support" : "Dealer"}:</strong> ${escapeHtml(m.content)}</p>`).join("");

    // Upsert: update the existing note in place, else create + store its id.
    if (conv.hubspot_note_id) {
      await updateConversationNote(conv.hubspot_note_id, body);
      await markLogged(admin, conversationId);
    } else {
      const { id } = await createConversationNote({ contactId, companyId, body });
      await markLogged(admin, conversationId, id);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[help] HubSpot transcript log failed:", message);
    try {
      await (admin as any).from("hubspot_sync_errors").insert({
        object_type: "contact", object_id: conversationId, op: "create",
        error_message: `help transcript: ${message}`, payload: { conversationId },
      });
    } catch { /* best-effort */ }
  }
}

async function markLogged(admin: any, conversationId: string, noteId?: string): Promise<void> {
  const patch: Record<string, unknown> = { hubspot_logged_at: new Date().toISOString() };
  if (noteId) patch.hubspot_note_id = noteId;
  await admin.from("help_conversations").update(patch).eq("id", conversationId);
}

function escapeHtml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
