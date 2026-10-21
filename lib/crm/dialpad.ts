// Dialpad API v2 client + webhook JWT verification for DA-CRM.
//
// Webhooks: when the Dialpad webhook is created with a `secret`, every event
// body is a JWT signed HS256 with that secret (developers.dialpad.com →
// Webhook Create). We verify it here — constant-time — before trusting any of
// it. Unsigned JSON is never accepted.
//
// REST: https://dialpad.com/api/v2, `Authorization: Bearer DIALPAD_API_KEY`.
// DIALPAD_API_BASE overrides the host (https://sandbox.dialpad.com for testing).

import { createHmac, timingSafeEqual } from "crypto";
import { crmEnv } from "./env";

export function dialpadApiBase(): string {
  return (crmEnv("DIALPAD_API_BASE") || "https://dialpad.com").replace(/\/+$/, "");
}

export function dialpadConfigured(): boolean {
  return !!crmEnv("DIALPAD_API_KEY");
}

/**
 * JSON.parse that keeps Dialpad's int64 ids exact: any bare integer of 16+
 * digits (ids; ms timestamps are 13) becomes a string before parsing.
 */
export function parseDialpadJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  } catch {
    // The rewrite hit digits inside a string value — plain parse is still correct
    // for every id below 2^53, which is all Dialpad issues today.
    return JSON.parse(text);
  }
}

// ── Webhook JWT (HS256) ──────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Sign a payload the way Dialpad does — used by the replay script and tests. */
export function signDialpadJwt(payload: unknown, secret: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

/**
 * Verify an HS256 JWT and return its payload, or null when the token is
 * malformed, uses another algorithm, has a bad signature, or is expired.
 */
export function verifyDialpadJwt(token: string, secret: string): Record<string, unknown> | null {
  if (!secret) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(fromB64url(h).toString("utf8"));
    if (header?.alg !== "HS256") return null;
    const want = createHmac("sha256", secret).update(`${h}.${p}`).digest();
    const got = fromB64url(s);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const payload = parseDialpadJson(fromB64url(p).toString("utf8")) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── REST ─────────────────────────────────────────────────────────────────────

export async function dialpadFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = crmEnv("DIALPAD_API_KEY");
  if (!key) throw new Error("DIALPAD_API_KEY not set");
  const res = await fetch(`${dialpadApiBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dialpad ${init.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? parseDialpadJson(text) : {}) as T;
}

/**
 * Click-to-call: rings the staff member's Dialpad devices, then dials `phone`
 * once they answer (POST /api/v2/call). Dialpad rate-limits this to 5/min.
 */
export async function initiateDialpadCall(dialpadUserId: string, phoneE164: string): Promise<{ call_id: string | null }> {
  if (!/^\d+$/.test(dialpadUserId)) throw new Error("invalid Dialpad user id");
  // user_id is an int64 — spliced in as a literal so it can't round through a JS number.
  const rest = JSON.stringify({ phone_number: phoneE164, custom_data: "da-crm" }).slice(1);
  const r = await dialpadFetch<{ call_id?: number | string }>("/api/v2/call", {
    method: "POST",
    body: `{"user_id":${dialpadUserId},${rest}`,
  });
  return { call_id: r.call_id != null ? String(r.call_id) : null };
}

/** Concluded calls started in [afterMs, beforeMs), newest first, all pages. */
export async function* listDialpadCalls(afterMs: number, beforeMs: number): AsyncGenerator<Record<string, unknown>> {
  let cursor: string | null = null;
  for (let page = 0; page < 200; page++) {
    const qs = new URLSearchParams({ started_after: String(afterMs), started_before: String(beforeMs) });
    if (cursor) qs.set("cursor", cursor);
    const r: { items?: Record<string, unknown>[]; cursor?: string | null } =
      await dialpadFetch(`/api/v2/call?${qs.toString()}`);
    for (const item of r.items ?? []) yield item;
    if (!r.cursor || !(r.items ?? []).length) return;
    cursor = r.cursor;
  }
}

type TranscriptLine = { name?: string | null; content?: string | null; type?: string | null; time?: string | null };

/** "Speaker: words" lines from a Dialpad transcript (moments etc. skipped). */
export function formatTranscript(lines: TranscriptLine[]): string {
  return lines
    .filter((l) => (l.type ?? "transcript") === "transcript" && l.content)
    .map((l) => `${l.name || "Unknown"}: ${String(l.content).trim()}`)
    .join("\n");
}

/** AI call transcript text, or null when Dialpad has none for this call. */
export async function fetchDialpadTranscript(dialpadCallId: string): Promise<string | null> {
  const r = await dialpadFetch<{ lines?: TranscriptLine[] }>(`/api/v2/transcripts/${encodeURIComponent(dialpadCallId)}`);
  const text = formatTranscript(r.lines ?? []);
  return text || null;
}

/** Fetch a Dialpad-hosted file (recording/voicemail), with our key when it's a Dialpad URL. */
export async function fetchDialpadMedia(url: string): Promise<Response> {
  const isDialpad = /^https:\/\/([a-z0-9-]+\.)*dialpad\.com\//i.test(url);
  const key = crmEnv("DIALPAD_API_KEY");
  return fetch(url, {
    headers: isDialpad && key ? { Authorization: `Bearer ${key}` } : {},
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
    cache: "no-store",
  });
}
