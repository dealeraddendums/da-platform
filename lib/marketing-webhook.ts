// Outbound trial→paid notification to the Marketing OS conversion join.
//
// Fire-and-forget: lights up the marketing funnel's Converted stage in
// real time, but a marketing-side outage must NEVER block or break a
// dealer's upgrade. Mirrors the da-billing → da-platform billing-cache
// invalidate webhook (secret header, no await on the caller's path).
//
// READ-ONLY w.r.t. billing — this only reports a conversion that already
// happened in DA Platform; it never writes to da-billing or Aurora.
//
// dealerId MUST be the dealer's text id (dealers.dealer_id, ss_*) — that's
// what marketing_leads.da_dealer_id stores from provisioning. groupId is the
// group UUID. Send whichever identifies the converting entity.

export interface ConversionPayload {
  dealerId?: string;
  groupId?: string;
  convertedAt: string;
  plan?: string;
  mrr?: number;
}

export function fireConversionWebhook(payload: ConversionPayload): void {
  const url = process.env.MARKETING_WEBHOOK_URL;
  const secret = process.env.MARKETING_WEBHOOK_SECRET;
  if (!url || !secret) return; // not configured (e.g. dev) — silently skip

  void (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(`${url.replace(/\/$/, "")}/api/conversions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    } catch (err) {
      // Never throw into the upgrade path — the daily reconcile cron is the
      // safety net for any missed webhook.
      console.error("[marketing-webhook] conversion notify failed:", err instanceof Error ? err.message : err);
    }
  })();
}
