// Steven (in-app chat) ⇄ DA-CRM human hand-off. Contract: steven-dacrm-api.md (suite root).
//
// Outbound: when a dealer asks for a person, Steven POSTs `human_requested` to
// DA-CRM's webhook (DACRM_WEBHOOK_URL), then `message` for every later dealer
// message and `conversation_closed` when the dealer or our side closes it.
// Inbound: DA-CRM calls /api/steven/* (reply, conversation, list, close, assign).
//
// Both directions are signed with the same shared secret (STEVEN_DACRM_SECRET):
//   X-Steven-Timestamp: <unix seconds>
//   X-Steven-Signature: sha256=<hex HMAC-SHA256(timestamp + "." + rawBody)>
// Server-side only — the secret never reaches the bubble.
//
// DACRM_INTEGRATION_ENABLED=1 runs this ALONGSIDE the HubSpot / email hand-off
// (lib/help-conversations escalateConversation); off = nothing here fires and
// /api/steven/* answers 503.
/* eslint-disable @typescript-eslint/no-explicit-any */

import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/db";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://app.dealeraddendums.com").replace(/\/$/, "");
const MAX_SKEW_S = 300;
/** A bubble that polled within this window is "present" — the reply shows live. */
const PRESENT_MS = 30_000;

export type StevenStatus = "bot" | "human_requested" | "agent_active" | "closed";

export function dacrmEnabled(): boolean {
  const flag = (process.env.DACRM_INTEGRATION_ENABLED || "").trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(flag) && !!process.env.STEVEN_DACRM_SECRET && !!process.env.DACRM_WEBHOOK_URL;
}

export function signBody(timestamp: string, rawBody: string, secret = process.env.STEVEN_DACRM_SECRET || ""): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function stevenError(status: number, error: string, message: string): NextResponse {
  return NextResponse.json({ error, message }, { status });
}

/**
 * Verify a DA-CRM → Steven request. Returns the raw body on success, else the
 * 401/503 response to send. Constant-time compare; ±300 s replay window.
 */
export async function verifyStevenRequest(req: Request): Promise<{ raw: string } | { fail: NextResponse }> {
  const secret = process.env.STEVEN_DACRM_SECRET;
  if (!secret || !dacrmEnabled()) return { fail: stevenError(503, "disabled", "DA-CRM integration is not enabled") };
  const raw = await req.text();
  const ts = req.headers.get("x-steven-timestamp") || "";
  const given = req.headers.get("x-steven-signature") || "";
  if (!/^\d{9,11}$/.test(ts) || !given) return { fail: stevenError(401, "unauthorized", "missing signature") };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) return { fail: stevenError(401, "unauthorized", "stale timestamp") };
  const a = Buffer.from(signBody(ts, raw, secret)), b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { fail: stevenError(401, "unauthorized", "invalid signature") };
  return { raw };
}

/** Parse a verified JSON body; GETs have an empty body. */
export function parseJson(raw: string): { ok: true; body: any } | { ok: false; fail: NextResponse } {
  if (!raw.trim()) return { ok: true, body: {} };
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { ok: true, body };
  } catch {
    return { ok: false, fail: stevenError(400, "bad_request", "malformed JSON") };
  }
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export function statusOf(conv: { status: string; agent_engaged_at?: string | null }): StevenStatus {
  if (conv.status === "resolved") return "closed";
  if (conv.status === "escalated") return conv.agent_engaged_at ? "agent_active" : "human_requested";
  return "bot";
}

export const CONV_COLUMNS =
  "id, user_id, dealer_id, group_id, role, status, page, handoff_provider, live_at, escalated_at, " +
  "agent_engaged_at, assigned_agent, last_seen_at, dacrm_requested_at, created_at, updated_at";

export function isPresent(conv: { last_seen_at?: string | null }): boolean {
  return !!conv.last_seen_at && Date.now() - new Date(conv.last_seen_at).getTime() < PRESENT_MS;
}

/** §6 dealer/user context — who asked and from which account. */
export async function dealerContext(admin: any, conv: { user_id: string | null; dealer_id: string | null; group_id: string | null; role: string | null }) {
  // Lazy import: help-conversations imports this module.
  const { resolveAsker } = await import("@/lib/help-conversations");
  const who = await resolveAsker(admin, conv);
  return {
    dealer_id: conv.dealer_id, name: who.dealership, email: who.email,
    user_name: who.name, user_role: who.role, group: who.group,
  };
}

export async function conversationMessages(admin: any, conversationId: string) {
  const { data } = await admin.from("help_messages")
    .select("id, role, content, sender_name, attachments, created_at")
    .eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(500);
  return ((data ?? []) as any[]).map((m) => ({
    id: m.id as string,
    role: m.role as "user" | "assistant" | "agent",
    text: withFileNames(m.content, m.attachments),
    agent_name: m.role === "agent" ? (m.sender_name ?? null) : null,
    ts: new Date(m.created_at).toISOString(),
  }));
}

function withFileNames(text: string, attachments: { name?: string }[] | null): string {
  const names = (attachments ?? []).map((a) => a?.name).filter(Boolean);
  return [text || "", ...names.map((n) => `[file: ${n}]`)].filter(Boolean).join("\n");
}

function pageUrl(page: string | null): string | null {
  if (!page) return null;
  return /^https?:\/\//i.test(page) ? page : `${APP_URL}${page.startsWith("/") ? "" : "/"}${page}`;
}

/**
 * POST one signed event to DA-CRM. Up to 4 attempts (initial + 3 retries,
 * 1s/2s/4s backoff); each attempt re-signed with a fresh timestamp. Never throws.
 */
export async function postToDacrm(payload: Record<string, unknown>): Promise<boolean> {
  const url = process.env.DACRM_WEBHOOK_URL;
  if (!url || !dacrmEnabled()) return false;
  const raw = JSON.stringify(payload);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    const ts = String(Math.floor(Date.now() / 1000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Steven-Timestamp": ts, "X-Steven-Signature": signBody(ts, raw) },
        body: raw, cache: "no-store", signal: controller.signal,
      });
      if (res.ok) return true;
      console.error(`[steven-dacrm] ${payload.event} → HTTP ${res.status} (attempt ${attempt + 1})`);
    } catch (e) {
      console.error(`[steven-dacrm] ${payload.event} failed (attempt ${attempt + 1}):`, e instanceof Error ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

/** §4.1 — the dealer asked for a person. Fire-and-forget; never throws. */
export async function notifyHumanRequested(conversationId: string): Promise<void> {
  if (!dacrmEnabled()) return;
  try {
    const admin = createAdminSupabaseClient() as any;
    const { data: conv } = await admin.from("help_conversations").select(CONV_COLUMNS).eq("id", conversationId).maybeSingle();
    if (!conv) return;
    const requestedAt = conv.escalated_at ?? new Date().toISOString();
    await admin.from("help_conversations").update({ dacrm_requested_at: new Date().toISOString() })
      .eq("id", conversationId).is("dacrm_requested_at", null);
    const ok = await postToDacrm({
      event: "human_requested",
      conversation_id: conv.id,
      dealer: await dealerContext(admin, conv),
      messages: await conversationMessages(admin, conv.id),
      page_url: pageUrl(conv.page),
      requested_at: new Date(requestedAt).toISOString(),
    });
    if (ok) await admin.from("help_conversations").update({ dacrm_delivered_at: new Date().toISOString() }).eq("id", conversationId);
  } catch (e) {
    console.error("[steven-dacrm] human_requested:", e instanceof Error ? e.message : e);
  }
}

/** §4.2 — a dealer message after the hand-off (only for conversations DA-CRM was told about). */
export async function notifyUserMessage(conv: { id: string; dacrm_requested_at?: string | null }, messageId: string | null, text: string): Promise<void> {
  if (!dacrmEnabled() || !conv.dacrm_requested_at) return;
  await postToDacrm({
    event: "message", conversation_id: conv.id,
    message: { id: messageId ?? `${conv.id}:${Date.now()}`, role: "user", text, ts: new Date().toISOString() },
  });
}

/** §4.3 — closed by the dealer or by our own support surface (not echoed for DA-CRM's own close). */
export async function notifyClosed(conversationId: string, closedBy: "user" | "agent" | "timeout"): Promise<void> {
  if (!dacrmEnabled()) return;
  const admin = createAdminSupabaseClient() as any;
  const { data: conv } = await admin.from("help_conversations").select("id, dacrm_requested_at").eq("id", conversationId).maybeSingle();
  if (!conv?.dacrm_requested_at) return;
  await postToDacrm({ event: "conversation_closed", conversation_id: conversationId, closed_by: closedBy, closed_at: new Date().toISOString() });
}
