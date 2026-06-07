import { NextRequest, NextResponse } from "next/server";
import { invalidateBillingStatusCache } from "@/lib/print-eligibility";

// Server-to-server webhook: da-billing calls this when a customer's Overdue Days
// changes or an invoice is paid/voided, so the past-due print lock reflects the
// change immediately instead of waiting out the cache TTL. Auth is a shared
// secret (X-Webhook-Secret = BILLING_CACHE_WEBHOOK_SECRET). Body: { customerId }
// (omit to clear the whole cache). Idempotent + cheap — worst case a forced
// cache miss costs one extra da-billing fetch.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.BILLING_CACHE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  if (req.headers.get("x-webhook-secret") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let customerId: string | null = null;
  try {
    const body = (await req.json()) as { customerId?: string };
    customerId = body.customerId?.trim() || null;
  } catch {
    // No/invalid body → clear all.
  }

  invalidateBillingStatusCache(customerId);
  return NextResponse.json({ ok: true, invalidated: customerId ?? "all" });
}
