// Shared auth + logging helpers for the XPS Shipper webhook endpoints
// (POST /api/webhooks/xps — shipment updates, and GET /api/webhooks/xps/orders
// — the "list orders" poll URL XPS requires us to advertise even though we
// always return an empty list).
//
// XPS doesn't sign payloads, so a shared secret IS the auth. Their docs
// don't specify which envelope they use for the secret, so we accept it
// from any plausible location (headers, body, query string) until we see
// a real call land and can tighten down.

import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function extractWebhookSecret(
  req: NextRequest,
  body: Record<string, unknown> = {},
): string | null {
  const headerNames = [
    "x-webhook-secret",
    "x-xps-secret",
    "x-api-key",
    "x-secret-key",
    "x-shared-secret",
  ];
  for (const h of headerNames) {
    const v = req.headers.get(h);
    if (v) return v.trim();
  }
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return (m ? m[1] : auth).trim();
  }
  // GET list-orders polls have no body; XPS may put the secret in the
  // query string instead.
  for (const k of ["secret", "secretKey", "apiKey", "webhookSecret"]) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) return v;
  }
  for (const k of ["secret", "secretKey", "apiKey", "webhookSecret"]) {
    const v = body[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: "missing-env" | "missing-secret" | "wrong-secret" };

export function validateWebhookSecret(
  req: NextRequest,
  body: Record<string, unknown> = {},
): ValidationResult {
  const expected = process.env.XPS_WEBHOOK_SECRET;
  if (!expected) {
    console.error("[webhooks/xps] XPS_WEBHOOK_SECRET not configured — refusing all webhook calls");
    return { ok: false, status: 503, reason: "missing-env" };
  }
  const provided = extractWebhookSecret(req, body);
  if (!provided) return { ok: false, status: 401, reason: "missing-secret" };
  if (!safeEqual(provided, expected)) return { ok: false, status: 401, reason: "wrong-secret" };
  return { ok: true };
}

export function collectHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
