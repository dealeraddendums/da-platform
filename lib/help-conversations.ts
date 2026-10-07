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
import { hubspotHandoffEnabled, handoffSummary, publishToInbox, type HelpAttachment } from "@/lib/help-handoff";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com";
const SUPPORT_EMAIL = "support@dealeraddendums.com";

/** Create a conversation row; returns its id. */
export async function createConversation(claims: JwtClaims, dealerId: string | null, contextSnapshot: string, page: string | null = null): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data } = await (admin as any)
    .from("help_conversations")
    .insert({ user_id: claims.sub, dealer_id: dealerId, role: claims.role, group_id: claims.group_id, context_snapshot: contextSnapshot, page })
    .select("id").single();
  return data?.id ?? null;
}

/** True only for the support team (super_admin) — gates the review surface. */
export function canReviewConversations(claims: JwtClaims): boolean {
  return claims.role === "super_admin";
}

/** Confirm a conversation belongs to this user (own-data guard for follow-ups). */
export async function ownsConversation(
  conversationId: string,
  claims: JwtClaims,
  admin: any = createAdminSupabaseClient(),
): Promise<boolean> {
  if (claims.role === "super_admin") return true;
  const { data } = await admin.from("help_conversations").select("user_id").eq("id", conversationId).maybeSingle();
  return !!data && data.user_id === claims.sub;
}

/**
 * List conversations for the caller. super_admin gets the review queue (optional
 * status/flagged filters); every other role is HARD-SCOPED to their own
 * (user_id = claims.sub) so a dealer can never read another dealer's threads.
 * `admin` is an injection seam for tests.
 */
export async function listConversations(
  claims: JwtClaims,
  opts: { status?: string | null; flagged?: boolean },
  admin: any = createAdminSupabaseClient(),
): Promise<{ data: unknown[]; error: { message: string } | null }> {
  let q = admin
    .from("help_conversations")
    .select("id, user_id, dealer_id, role, status, flagged, escalated_at, resolved_at, hubspot_logged_at, created_at, updated_at")
    .order("flagged", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(200);

  if (canReviewConversations(claims)) {
    if (opts.status && ["open", "escalated", "resolved"].includes(opts.status)) q = q.eq("status", opts.status);
    if (opts.flagged) q = q.eq("flagged", true);
  } else {
    q = q.eq("user_id", claims.sub);
  }

  const { data, error } = await q;
  return { data: data ?? [], error: error ?? null };
}

export async function appendMessage(
  conversationId: string,
  role: "user" | "assistant" | "agent",
  content: string,
  extra: { attachments?: HelpAttachment[]; senderName?: string | null; externalId?: string | null } = {},
): Promise<string | null> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await (admin as any)
    .from("help_messages").insert({
      conversation_id: conversationId, role, content,
      attachments: extra.attachments ?? [], sender_name: extra.senderName ?? null, external_id: extra.externalId ?? null,
    }).select("id").single();
  // 23505 on external_id = a retried relay for a reply already stored.
  if (error && error.code !== "23505") console.error("[help] appendMessage failed:", error.message);
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
 * Who asked: the conversation's user_id resolved to the profile (name, email,
 * role) plus the dealership and group in context. The escalation email used to
 * carry only the dealer-context snapshot (role/plan/billing) — support could
 * see WHAT account but never WHO, for every role. Profile role wins over the
 * role stamped on the conversation (that one is the claims role at the time).
 */
export async function resolveAsker(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  conv: { user_id: string | null; dealer_id: string | null; group_id: string | null; role: string | null },
): Promise<{ name: string | null; email: string | null; role: string | null; dealership: string | null; group: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = admin as any;
  const [prof, dealer] = await Promise.all([
    conv.user_id ? a.from("profiles").select("full_name, email, role, group_id").eq("id", conv.user_id).maybeSingle() : { data: null },
    conv.dealer_id ? a.from("dealers").select("name, group_id").eq("dealer_id", conv.dealer_id).maybeSingle() : { data: null },
  ]);
  const p = prof?.data as { full_name: string | null; email: string | null; role: string | null; group_id: string | null } | null;
  const d = dealer?.data as { name: string | null; group_id: string | null } | null;
  const groupId = conv.group_id ?? p?.group_id ?? d?.group_id ?? null;
  const { data: g } = groupId ? await a.from("groups").select("name").eq("id", groupId).maybeSingle() : { data: null };
  return {
    name: p?.full_name?.trim() || null,
    email: p?.email?.trim() || null,
    role: p?.role ?? conv.role ?? null,
    dealership: d?.name ?? null,
    group: (g as { name: string | null } | null)?.name ?? null,
  };
}

export interface EscalationResult {
  channel: "hubspot" | "email" | "none";
  /** True when a person can now reply inside the bubble (HubSpot). */
  live: boolean;
  /** Poll cursor — the moment the conversation went live. */
  at?: string;
}

/**
 * THE escalation target — the one function the bubble, the [[ESCALATE]]
 * sentinel and the escalate action all call. Live HubSpot hand-off when
 * HELP_HANDOFF_PROVIDER=hubspot; email otherwise, and email whenever the
 * HubSpot publish fails. Idempotent: an already-live conversation just returns
 * its cursor.
 */
export async function escalateConversation(conversationId: string): Promise<EscalationResult> {
  const admin = createAdminSupabaseClient();
  const { data: conv } = await (admin as any)
    .from("help_conversations")
    .select("id, user_id, dealer_id, group_id, role, context_snapshot, status, handoff_provider, live_at, page")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return { channel: "none", live: false };

  if (conv.handoff_provider === "hubspot" && conv.live_at) {
    return { channel: "hubspot", live: true, at: new Date(new Date(conv.live_at).getTime() - 1000).toISOString() };
  }

  if (hubspotHandoffEnabled(conv.dealer_id)) {
    const who = await resolveAsker(admin, conv);
    const { data: msgs } = await (admin as any)
      .from("help_messages").select("role, content").eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    const pub = await publishToInbox({
      conversationId, idempotencyId: `${conversationId}:open`, who, userId: conv.user_id,
      text: handoffSummary({ who, dealerId: conv.dealer_id, page: conv.page, contextSnapshot: conv.context_snapshot, messages: msgs ?? [] }),
    });
    if (pub.ok) {
      const now = new Date().toISOString();
      await (admin as any).from("help_conversations").update({
        status: "escalated", escalated_at: now, handoff_provider: "hubspot", live_at: now, escalation_notified_at: now,
      }).eq("id", conversationId);
      return { channel: "hubspot", live: true, at: new Date(Date.now() - 1000).toISOString() };
    }
    // fall through to email — a person must still hear about it
  }

  await escalateByEmail(conversationId);
  return { channel: "email", live: false };
}

/**
 * Email escalation: mark escalated and — once per escalation (debounced via
 * escalation_notified_at) — Mandrill-notify support with the dealer context +
 * a deep link to the review surface.
 */
export async function escalateByEmail(conversationId: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { data: conv } = await (admin as any)
    .from("help_conversations")
    .select("id, user_id, dealer_id, group_id, role, context_snapshot, status, escalation_notified_at")
    .eq("id", conversationId).maybeSingle();
  if (!conv) return;

  await (admin as any).from("help_conversations")
    .update({ status: "escalated", escalated_at: new Date().toISOString(), handoff_provider: "email" })
    .eq("id", conversationId);

  if (conv.escalation_notified_at) return; // already notified — debounce

  // Last few turns for context in the email.
  const { data: msgs } = await (admin as any)
    .from("help_messages").select("role, content, created_at").eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  const transcript = (msgs ?? []).slice(-8).map((m: any) => `<p><strong>${m.role}:</strong> ${escapeHtml(m.content).slice(0, 1200)}</p>`).join("");
  const link = `${APP_URL}/help/manage?tab=conversations&id=${conversationId}`;
  const who = await resolveAsker(admin, conv);

  try {
    await sendMandrillEmail({
      subject: `Help escalation — ${who.name ?? who.email ?? "a user"}${who.dealership ? ` (${who.dealership})` : who.group ? ` (${who.group})` : ""} needs a person`,
      from_email: "noreply@dealeraddendums.com",
      from_name: "DA Help",
      to: [{ email: SUPPORT_EMAIL, name: "DA Support", type: "to" }],
      // Replying from the support inbox goes straight to the person who asked.
      ...(who.email ? { headers: { "Reply-To": who.email } } : {}),
      html:
        `<p>A dealer asked for a person (or the assistant couldn't resolve it).</p>` +
        `<h4>Asked by</h4><p>` +
        `<strong>${escapeHtml(who.name ?? "(no name on profile)")}</strong>` +
        (who.email ? ` &lt;<a href="mailto:${escapeHtml(who.email)}">${escapeHtml(who.email)}</a>&gt;` : " (no email on profile)") +
        `<br>Role: ${escapeHtml(who.role ?? "unknown")}` +
        (who.dealership ? `<br>Dealership: ${escapeHtml(who.dealership)}${conv.dealer_id ? ` — Dealer ID ${escapeHtml(conv.dealer_id)}` : ""}` : "") +
        (who.group ? `<br>Group: ${escapeHtml(who.group)}` : "") +
        `<br>User id: ${escapeHtml(conv.user_id ?? "unknown")}</p>` +
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
