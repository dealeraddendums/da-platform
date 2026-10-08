// Steven (in-app chat) → a person, live, in the HubSpot Support inbox.
//
// da-platform holds NO HubSpot credentials for this. The custom-channel bridge
// lives in da-marketing-os (one bridge, two surfaces): we ask it to publish a
// dealer's message on the in-app channel account, and it forwards agent replies
// back to /api/help/hubspot-relay. Auth both ways is the X-Webhook-Secret both
// apps already share (MARKETING_WEBHOOK_SECRET).
//
// HELP_HANDOFF_PROVIDER=hubspot turns live hand-off on; anything else keeps
// the email escalation (lib/help-conversations escalateByEmail). A failed
// HubSpot publish falls back to email, so an escalation is never lost.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminSupabaseClient } from "@/lib/db";

export const HELP_CHAT_BUCKET = "help-chat-attachments";
export const MAX_HELP_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_HELP_MIME = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/heic",
  "application/pdf", "text/plain", "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export interface HelpAttachment { name: string; mime: string; size: number; path: string }

function marketingBase(): string {
  return (process.env.MARKETING_SITE_URL || "https://www.dealeraddendums.com").replace(/\/$/, "");
}

/**
 * Live HubSpot hand-off for this dealer? Decided by the `help_handoff` row in
 * admin_settings — a switch that takes effect within a minute, no deploy:
 *   {"mode":"off"}                                   kill switch: email for everyone
 *   {"mode":"pilot","dealers":["dealer_id", ...]}    only these dealers go live
 *   {"mode":"all"}                                   every dealer
 * QA dealers in HELP_HANDOFF_TEST_DEALERS are always live so the bridge can be
 * tested. With no row, HELP_HANDOFF_PROVIDER=hubspot means "all" (the original
 * env switch). Anything that can't be read falls back to email.
 */
type HandoffSetting = { mode?: "off" | "pilot" | "all"; dealers?: string[] };
let settingCache: { at: number; value: HandoffSetting | null } | null = null;

async function handoffSetting(): Promise<HandoffSetting | null> {
  if (settingCache && Date.now() - settingCache.at < 60_000) return settingCache.value;
  let value: HandoffSetting | null = null;
  try {
    const { data } = await createAdminSupabaseClient().from("admin_settings")
      .select("value").eq("key", "help_handoff").maybeSingle<{ value: string | null }>();
    value = data?.value ? (JSON.parse(data.value) as HandoffSetting) : null;
  } catch {
    value = settingCache?.value ?? null; // keep the last good value on a read hiccup
  }
  settingCache = { at: Date.now(), value };
  return value;
}

export async function hubspotHandoffEnabled(dealerId?: string | null): Promise<boolean> {
  if (!process.env.MARKETING_WEBHOOK_SECRET) return false;
  const testers = (process.env.HELP_HANDOFF_TEST_DEALERS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (dealerId && testers.includes(dealerId)) return true;
  const s = await handoffSetting();
  if (s?.mode === "off") return false;
  if (s?.mode === "all") return true;
  if (s?.mode === "pilot") return !!dealerId && (s.dealers ?? []).includes(dealerId);
  return process.env.HELP_HANDOFF_PROVIDER === "hubspot";
}

/** One bounded call to the marketing gateway. Never throws. */
export async function callGateway(path: string, body: unknown, timeoutMs = 20_000): Promise<{ ok: boolean; status: number; data: any }> {
  if (!process.env.MARKETING_WEBHOOK_SECRET) return { ok: false, status: 0, data: "MARKETING_WEBHOOK_SECRET unset" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${marketingBase()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": process.env.MARKETING_WEBHOOK_SECRET },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export interface Asker {
  name: string | null; email: string | null; role: string | null;
  dealership: string | null; group: string | null;
}

/** The first message an agent sees: who (resolveAsker), which account, where
 *  in the app, and the whole Steven conversation. */
export function handoffSummary(opts: {
  who: Asker; dealerId: string | null; page: string | null; contextSnapshot: string | null;
  messages: { role: string; content: string }[];
}): string {
  const { who } = opts;
  const turns = opts.messages
    .filter((m) => (m.content || "").trim())
    .slice(-30)
    .map((m) => `${m.role === "assistant" ? "Steven" : m.role === "agent" ? "Support" : "Dealer"}: ${m.content.trim().slice(0, 800)}`);
  return [
    "In-app chat (DA Platform) — the dealer asked for a person.",
    `Who: ${[who.name, who.email, who.role].filter(Boolean).join(" · ") || "unknown"}`,
    `Dealership: ${[who.dealership, opts.dealerId && `Dealer ID ${opts.dealerId}`].filter(Boolean).join(" · ") || "none in context"}`,
    who.group ? `Group: ${who.group}` : "",
    opts.page ? `Page: ${opts.page}` : "",
    "",
    opts.contextSnapshot ? `Account: ${opts.contextSnapshot.replace(/\n/g, " | ")}` : "",
    "",
    "— Conversation with Steven —",
    ...(turns.length ? turns : ["(no transcript)"]),
  ].filter((l, i, a) => l !== "" || (a[i - 1] ?? "") !== "").join("\n").slice(0, 15000);
}

/** Publish one dealer message (optionally with files) into the inbox thread. */
export async function publishToInbox(opts: {
  conversationId: string; idempotencyId: string; text: string; who: Asker; userId: string | null;
  files?: { name: string; mime: string; bytes: Buffer }[];
}): Promise<{ ok: boolean; error?: string }> {
  const r = await callGateway("/api/hubspot-chat/inapp/publish", {
    threadId: opts.conversationId,
    idempotencyId: opts.idempotencyId,
    text: opts.text,
    visitorName: opts.who.name || opts.who.dealership || null,
    visitorEmail: opts.who.email,
    visitorKey: `app-${opts.userId ?? opts.conversationId}`,
    files: (opts.files || []).map((f) => ({ name: f.name, mime: f.mime, base64: f.bytes.toString("base64") })),
  }, 45_000);
  if (!r.ok) {
    const error = `gateway HTTP ${r.status}: ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}`.slice(0, 400);
    console.error("[help-handoff] publish failed:", error);
    return { ok: false, error };
  }
  return { ok: true };
}

export async function storeHelpFile(conversationId: string, name: string, mime: string, bytes: Buffer): Promise<HelpAttachment> {
  const safe = (name || "file").replace(/[^\w.\- ]+/g, "_").slice(-120) || "file";
  const path = `${conversationId}/${Date.now()}-${safe}`;
  const admin = createAdminSupabaseClient();
  const { error } = await admin.storage.from(HELP_CHAT_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
  if (error) throw new Error(`storing chat file: ${error.message}`);
  return { name: safe, mime, size: bytes.length, path };
}
