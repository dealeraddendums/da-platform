// Microsoft Graph client for the DA-CRM Inbox (app-only / client credentials).
//
// Auth: MS_TENANT_ID + MS_CLIENT_ID + MS_CLIENT_SECRET (crmEnv — loaded from
// /var/www/da-platform/.env.local by explicit path, never logged). The token is
// cached per process and refreshed 5 minutes before it expires.
// The Azure app is scoped to support@ and feeds@ by an Exchange
// ApplicationAccessPolicy (CLAUDE.md → "Azure app registration runbook").
//
// Every request sends Prefer: IdType="ImmutableId", so message ids survive
// folder moves (Drafts → Sent Items) and change notifications carry the same
// ids — the dedupe in lib/crm/inbox-ingest.ts depends on that.
// Throttling (429 / 503 / 504) is retried with Retry-After, three times.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { timingSafeEqual } from "crypto";
import { crmEnv } from "./env";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const GRAPH_WEBHOOK_PATH = "/api/crm/graph/webhook";
/** Mail subscriptions max out at 4230 minutes; stay under it. */
export const SUBSCRIPTION_MINUTES = 4200;

export type GraphFolder = "inbox" | "sentitems";

export class GraphError extends Error {
  constructor(public status: number, public code: string | null, message: string) {
    super(message);
    this.name = "GraphError";
  }
}

export function graphConfigured(): boolean {
  return !!(crmEnv("MS_TENANT_ID") && crmEnv("MS_CLIENT_ID") && crmEnv("MS_CLIENT_SECRET"));
}

export function graphWebhookUrl(): string {
  const base = (crmEnv("CRM_PUBLIC_BASE_URL") || "https://app.dealeraddendums.com").replace(/\/+$/, "");
  return `${base}${GRAPH_WEBHOOK_PATH}`;
}

/** clientState check for change notifications (constant-time). */
export function validClientState(got: unknown): boolean {
  const want = crmEnv("MS_GRAPH_WEBHOOK_SECRET");
  if (!want || typeof got !== "string") return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Token ────────────────────────────────────────────────────────────────────

let cached: { token: string; expiresAt: number } | null = null;

export async function graphToken(): Promise<string> {
  if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
  const tenant = crmEnv("MS_TENANT_ID"), id = crmEnv("MS_CLIENT_ID"), secret = crmEnv("MS_CLIENT_SECRET");
  if (!tenant || !id || !secret) throw new GraphError(0, "not_configured", "MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET not set");
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // error / error_description never contain the secret.
    throw new GraphError(res.status, j.error ?? null, `token: ${j.error_description?.split("\r\n")[0] ?? res.status}`);
  }
  cached = { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// ── Requests ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Graph request. `path` is relative to /v1.0 or an absolute nextLink /
 * deltaLink. Returns parsed JSON, or null for 202 / 204.
 */
export async function graphFetch<T = any>(path: string, init: RequestInit & { prefer?: string[] } = {}): Promise<T> {
  const url = /^https:\/\//.test(path) ? path : `${GRAPH_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  const { prefer = [], ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    const headers = new Headers(rest.headers);
    headers.set("Authorization", `Bearer ${await graphToken()}`);
    headers.set("Prefer", ['IdType="ImmutableId"', ...prefer].join(", "));
    if (rest.body && typeof rest.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(url, { ...rest, headers });
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 3) {
      const wait = Math.min(30, Number(res.headers.get("Retry-After")) || 2 ** attempt * 2);
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 && attempt === 0) { cached = null; continue; }
    if (res.status === 202 || res.status === 204) return null as T;
    const text = await res.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!res.ok) throw new GraphError(res.status, j?.error?.code ?? null, `${rest.method ?? "GET"} ${url.replace(GRAPH_BASE, "")}: ${j?.error?.message ?? res.status}`);
    return j as T;
  }
}

/** Raw bytes (attachment $value). */
export async function graphFetchBytes(path: string): Promise<Buffer> {
  const res = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${await graphToken()}`, Prefer: 'IdType="ImmutableId"' } });
  if (!res.ok) throw new GraphError(res.status, null, `GET ${path}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Every mailbox-scoped call goes to /users/{graph user id} — the mailbox's Entra
// object id (crm_mailboxes.graph_user_id), never the address: support@ is an
// alias on another mailbox, and the id survives renames.
const u = (userId: string) => `/users/${encodeURIComponent(userId)}`;

/** The Graph user id for a mailbox row; throws when it isn't set. */
export function graphUserOf(mb: { address: string; graph_user_id?: string | null }): string {
  if (!mb.graph_user_id) throw new GraphError(0, "not_configured", `crm_mailboxes.graph_user_id not set for ${mb.address}`);
  return mb.graph_user_id;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export const MESSAGE_SELECT = [
  "id", "conversationId", "internetMessageId", "internetMessageHeaders", "subject", "from", "sender",
  "toRecipients", "ccRecipients", "bccRecipients", "replyTo", "receivedDateTime", "sentDateTime",
  "hasAttachments", "body", "bodyPreview", "isDraft", "parentFolderId", "importance",
].join(",");

/** One message by immutable id; null when it's gone (deleted / moved out of reach). */
export async function getMessage(userId: string, id: string): Promise<any | null> {
  try {
    return await graphFetch(`${u(userId)}/messages/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT}`, { prefer: ['outlook.body-content-type="html"'] });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return null;
    throw e;
  }
}

export async function listAttachments(userId: string, messageId: string): Promise<any[]> {
  const j: any = await graphFetch(`${u(userId)}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`);
  return j?.value ?? [];
}

export async function getAttachmentBytes(userId: string, messageId: string, attachmentId: string): Promise<Buffer> {
  return graphFetchBytes(`${u(userId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`);
}

/** contentId isn't selectable on the base attachment type — read it per attachment. */
export async function getAttachmentMeta(userId: string, messageId: string, attachmentId: string): Promise<any> {
  return graphFetch(`${u(userId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,size,isInline,contentId`);
}

// ── Delta ────────────────────────────────────────────────────────────────────

/** First delta URL for a folder: ids only, received on/after `since`. */
export function initialDeltaUrl(userId: string, folder: GraphFolder, since: Date): string {
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  return `${GRAPH_BASE}${u(userId)}/mailFolders/${folder}/messages/delta?$select=id,isDraft&$filter=${filter}`;
}

/**
 * Walk a delta chain from `startUrl` (an initial URL or a saved deltaLink),
 * calling `onIds` per page. Returns the new deltaLink.
 */
export async function walkDelta(startUrl: string, onIds: (ids: string[]) => Promise<void>): Promise<string> {
  let next: string | null = startUrl;
  while (next) {
    const page: any = await graphFetch(next, { prefer: ["odata.maxpagesize=100"] });
    const ids = (page?.value ?? []).filter((m: any) => !m["@removed"] && !m.isDraft).map((m: any) => m.id);
    if (ids.length) await onIds(ids);
    if (page?.["@odata.deltaLink"]) return page["@odata.deltaLink"];
    next = page?.["@odata.nextLink"] ?? null;
  }
  throw new GraphError(0, "delta_incomplete", "delta chain ended without a deltaLink");
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export function subscriptionResource(userId: string, folder: GraphFolder): string {
  return `users/${userId}/mailFolders('${folder}')/messages`;
}

export async function createSubscription(userId: string, folder: GraphFolder): Promise<{ id: string; expirationDateTime: string }> {
  const clientState = crmEnv("MS_GRAPH_WEBHOOK_SECRET");
  if (!clientState) throw new GraphError(0, "not_configured", "MS_GRAPH_WEBHOOK_SECRET not set");
  return graphFetch("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: graphWebhookUrl(),
      resource: subscriptionResource(userId, folder),
      expirationDateTime: new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString(),
      clientState,
    }),
  });
}

/** Extend; null when Graph no longer has it (caller recreates). */
export async function renewSubscription(id: string): Promise<{ id: string; expirationDateTime: string } | null> {
  try {
    return await graphFetch(`/subscriptions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString() }),
    });
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return null;
    throw e;
  }
}

export async function deleteSubscription(id: string): Promise<void> {
  try { await graphFetch(`/subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  catch (e) { if (!(e instanceof GraphError && e.status === 404)) throw e; }
}

// ── Sending ──────────────────────────────────────────────────────────────────
// Reply / reply-all / forward go through createReply* + PATCH + send (rather
// than the one-shot /reply) so DA-CRM gets the message id and Message-ID back
// to store immediately; Outlook still threads it as a normal reply.

export type Recipient = { email: string; name?: string | null };

export function toGraphRecipients(list: Recipient[]): { emailAddress: { address: string; name?: string } }[] {
  const seen = new Set<string>();
  const out: { emailAddress: { address: string; name?: string } }[] = [];
  for (const r of list) {
    const address = (r.email ?? "").trim().toLowerCase();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push({ emailAddress: r.name?.trim() ? { address, name: r.name.trim() } : { address } });
  }
  return out;
}

/** Our composed HTML above Outlook's quoted history (inside <body> when there is one). */
export function mergeQuotedBody(ourHtml: string, draftHtml: string | null | undefined): string {
  const quoted = draftHtml ?? "";
  if (!quoted.trim()) return ourHtml;
  const m = /<body[^>]*>/i.exec(quoted);
  if (!m) return `${ourHtml}${quoted}`;
  const at = m.index + m[0].length;
  return `${quoted.slice(0, at)}${ourHtml}${quoted.slice(at)}`;
}

export type DraftPatch = {
  subject?: string;
  from?: { emailAddress: { address: string; name?: string } };
  body: { contentType: "HTML"; content: string };
  toRecipients: ReturnType<typeof toGraphRecipients>;
  ccRecipients: ReturnType<typeof toGraphRecipients>;
  bccRecipients: ReturnType<typeof toGraphRecipients>;
};

export function buildDraftPatch(input: { subject?: string | null; from?: Recipient | null; html: string; quotedHtml?: string | null; to: Recipient[]; cc: Recipient[]; bcc: Recipient[] }): DraftPatch {
  // `from` pins the sending address (e.g. the support@ alias, not the mailbox's primary).
  const from = input.from ? toGraphRecipients([input.from])[0] : undefined;
  return {
    ...(input.subject != null ? { subject: input.subject } : {}),
    ...(from ? { from } : {}),
    body: { contentType: "HTML", content: mergeQuotedBody(input.html, input.quotedHtml) },
    toRecipients: toGraphRecipients(input.to),
    ccRecipients: toGraphRecipients(input.cc),
    bccRecipients: toGraphRecipients(input.bcc),
  };
}

export type ReplyMode = "reply" | "replyAll" | "forward";
const CREATE: Record<ReplyMode, string> = { reply: "createReply", replyAll: "createReplyAll", forward: "createForward" };

/** Draft reply / reply-all / forward of `messageId` (Graph fills recipients + quoted history). */
export async function createReplyDraft(userId: string, messageId: string, mode: ReplyMode): Promise<any> {
  return graphFetch(`${u(userId)}/messages/${encodeURIComponent(messageId)}/${CREATE[mode]}`, { method: "POST", body: "{}", prefer: ['outlook.body-content-type="html"'] });
}

export async function createNewDraft(userId: string): Promise<any> {
  return graphFetch(`${u(userId)}/messages`, { method: "POST", body: JSON.stringify({ subject: "", body: { contentType: "HTML", content: "" } }) });
}

export async function patchDraft(userId: string, draftId: string, patch: DraftPatch): Promise<any> {
  return graphFetch(`${u(userId)}/messages/${encodeURIComponent(draftId)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function sendDraft(userId: string, draftId: string): Promise<void> {
  await graphFetch(`${u(userId)}/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" });
}

export async function deleteDraft(userId: string, draftId: string): Promise<void> {
  try { await graphFetch(`${u(userId)}/messages/${encodeURIComponent(draftId)}`, { method: "DELETE" }); } catch { /* best effort */ }
}

const SMALL_ATTACHMENT = 3 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10; // 3.125 MiB — upload-session chunks must be multiples of 320 KiB

/** Attach a file to a draft: inline for < 3 MB, otherwise an upload session in chunks. */
export async function addDraftAttachment(userId: string, draftId: string, file: { name: string; contentType: string; bytes: Buffer }): Promise<void> {
  const base = `${u(userId)}/messages/${encodeURIComponent(draftId)}/attachments`;
  if (file.bytes.length < SMALL_ATTACHMENT) {
    await graphFetch(base, {
      method: "POST",
      body: JSON.stringify({ "@odata.type": "#microsoft.graph.fileAttachment", name: file.name, contentType: file.contentType, contentBytes: file.bytes.toString("base64") }),
    });
    return;
  }
  const session: any = await graphFetch(`${base}/createUploadSession`, {
    method: "POST",
    body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: file.name, size: file.bytes.length, contentType: file.contentType } }),
  });
  const total = file.bytes.length;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    // The upload URL is pre-authorized — no bearer token.
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${total}` },
      body: new Uint8Array(file.bytes.subarray(start, end)),
    });
    if (!res.ok) throw new GraphError(res.status, null, `attachment upload ${file.name}: ${res.status}`);
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

/** Can the app read this mailbox? (Used by the setup script's --check.) */
export async function probeMailbox(userId: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const j: any = await graphFetch(`${u(userId)}/mailFolders/inbox?$select=displayName,totalItemCount,unreadItemCount`);
    return { ok: true, detail: `${j.displayName}: ${j.totalItemCount} messages, ${j.unreadItemCount} unread` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
