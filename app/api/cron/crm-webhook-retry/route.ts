import { NextRequest, NextResponse } from "next/server";
import { retryDueDeliveries } from "@/lib/crm/outbound";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * POST /api/cron/crm-webhook-retry (X-Cron-Secret) — EasyCron every 5 min.
 * Re-attempts due DA-CRM outbound webhook deliveries (lib/crm/outbound.ts,
 * backoff 1m → 12h, 8 attempts then 'failed').
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await retryDueDeliveries());
}
