import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { ping, fortellisConfigured, isOutageErrorType } from "@/lib/fortellis-api";
import { createAdminSupabaseClient } from "@/lib/db";
import { markHealthy, markDown } from "@/lib/fortellis-sync";

/**
 * POST /api/admin/fortellis/test
 * Body: { subscription_id, web_id?, dealer_code? }
 *
 * One-call connectivity probe for a dealer. Returns the vehicle count (parity
 * with the CDK Test button). Feeds the availability state machine.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!fortellisConfigured()) {
    return NextResponse.json({ error: "Fortellis credentials not configured" }, { status: 500 });
  }

  let body: { subscription_id?: string; web_id?: string; dealer_code?: string };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const subscriptionId = body.subscription_id?.trim();
  if (!subscriptionId) return NextResponse.json({ error: "subscription_id is required" }, { status: 400 });

  const result = await ping({
    subscriptionId,
    webId: body.web_id?.trim() || null,
    dealerCode: body.dealer_code?.trim() || null,
  });

  const admin = createAdminSupabaseClient();
  try {
    // Only a true outage (network/5xx/timeout/token) flips the availability state.
    // 4xx (bad subscription, not-configured, unauthorized) is dealer/config-level.
    if (result.ok) await markHealthy(admin);
    else if (isOutageErrorType(result.errorType)) await markDown(admin, result.error ?? "test failed");
  } catch { /* health tracking is best-effort */ }

  // request_id/http_status surfaced so a failed Test can go straight into a
  // Fortellis support ticket without querying fortellis_api_log.
  return NextResponse.json(result.ok
    ? { success: true, count: result.count, request_id: result.requestId, http_status: result.httpStatus }
    : { success: false, error: result.error, request_id: result.requestId, http_status: result.httpStatus });
}
