// DA-CRM outbound webhooks (da-billing and any future subscriber).
//
// emitCrmEvent() writes one crm_webhook_deliveries row per active
// subscription that listens for the event, then attempts it straight away
// (fire-and-forget). Failures retry with backoff from the cron
// POST /api/cron/crm-webhook-retry until MAX_ATTEMPTS, then status='failed'.
//
// Contract (CLAUDE.md → DA-CRM → da-billing webhook contract):
//   POST <subscriber url>   Content-Type: application/json
//   X-DA-CRM-Event:      company.stage_changed
//   X-DA-CRM-Delivery:   <delivery uuid>  (same on every retry — dedupe on it)
//   X-DA-CRM-Timestamp:  <unix seconds>
//   X-DA-CRM-Signature:  sha256=<hex HMAC-SHA256(timestamp + "." + rawBody, CRM_WEBHOOK_SECRET)>
//   body: { id, event, occurred_at, data }
// Any 2xx = delivered. Receivers should reject a timestamp skew > 300 s.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHmac, randomUUID } from "crypto";
import { createAdminSupabaseClient } from "@/lib/db";
import { crmEnv } from "./env";

export const CRM_EVENTS = ["company.stage_changed", "company.owner_changed", "contact.created", "contact.updated"] as const;
export type CrmEvent = (typeof CRM_EVENTS)[number];

export const MAX_ATTEMPTS = 8;
/** Minutes to wait after attempt n (1-based) fails. */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720];

export function nextAttemptDelayMs(attempts: number): number {
  return (BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] ?? 720) * 60_000;
}

export function signCrmWebhook(timestamp: string, body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Queue + attempt `event` for every subscriber. Never throws. */
export async function emitCrmEvent(event: CrmEvent, data: Record<string, unknown>, admin: any = createAdminSupabaseClient()): Promise<void> {
  try {
    const { data: subs } = await admin.from("crm_webhook_subscriptions").select("id").eq("active", true).contains("events", [event]);
    if (!subs?.length) return;
    const eventId = randomUUID();
    const payload = { id: eventId, event, occurred_at: new Date().toISOString(), data };
    const { data: rows, error } = await admin.from("crm_webhook_deliveries")
      // next_attempt_at in the future so the retry cron doesn't race the
      // immediate attempt below.
      .insert(subs.map((s: any) => ({
        subscription_id: s.id, event, event_id: eventId, payload,
        next_attempt_at: new Date(Date.now() + 2 * 60_000).toISOString(),
      })))
      .select("id");
    if (error) { console.error("[crm-webhook] queue:", error.message); return; }
    for (const r of rows ?? []) void attemptDelivery(r.id, admin);
  } catch (e) {
    console.error("[crm-webhook] emit:", e instanceof Error ? e.message : e);
  }
}

/** One delivery attempt; updates the row with the outcome. */
export async function attemptDelivery(deliveryId: string, admin: any = createAdminSupabaseClient()): Promise<boolean> {
  const { data: d } = await admin.from("crm_webhook_deliveries")
    .select("id, event, payload, attempts, status, subscription:crm_webhook_subscriptions(url, active)")
    .eq("id", deliveryId).maybeSingle();
  if (!d || d.status !== "pending") return false;
  const secret = crmEnv("CRM_WEBHOOK_SECRET");
  const attempts = d.attempts + 1;
  let ok = false, code: number | null = null, err: string | null = null;
  if (!secret) err = "CRM_WEBHOOK_SECRET not set";
  else if (!d.subscription?.active) err = "subscription inactive";
  else {
    const body = JSON.stringify(d.payload);
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(d.subscription.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-DA-CRM-Event": d.event,
          "X-DA-CRM-Delivery": d.id,
          "X-DA-CRM-Timestamp": ts,
          "X-DA-CRM-Signature": signCrmWebhook(ts, body, secret),
        },
        body,
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      code = res.status;
      ok = res.ok;
      if (!ok) err = (await res.text().catch(() => "")).slice(0, 500) || `HTTP ${res.status}`;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  const done = ok || attempts >= MAX_ATTEMPTS;
  await admin.from("crm_webhook_deliveries").update({
    attempts,
    status: ok ? "delivered" : done ? "failed" : "pending",
    last_status_code: code,
    last_error: ok ? null : err,
    delivered_at: ok ? new Date().toISOString() : null,
    next_attempt_at: new Date(Date.now() + (ok ? 0 : nextAttemptDelayMs(attempts))).toISOString(),
  }).eq("id", d.id);
  if (!ok && done) console.error(`[crm-webhook] gave up on ${d.id} (${d.event}) after ${attempts} attempts: ${err}`);
  return ok;
}

/** Retry every due pending delivery (cron). */
export async function retryDueDeliveries(admin: any = createAdminSupabaseClient()): Promise<{ attempted: number; delivered: number }> {
  const { data } = await admin.from("crm_webhook_deliveries").select("id")
    .eq("status", "pending").lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at").limit(200);
  let delivered = 0;
  for (const r of data ?? []) if (await attemptDelivery(r.id, admin)) delivered++;
  return { attempted: (data ?? []).length, delivered };
}
