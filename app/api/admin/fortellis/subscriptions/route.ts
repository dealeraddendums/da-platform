import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { getSubscriptions, fortellisConfigured } from "@/lib/fortellis-api";

/**
 * GET /api/admin/fortellis/subscriptions
 * Lists the DA app's Fortellis Marketplace subscriptions for the Add-dealer
 * picker + "detect new subscriptions". super_admin only.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;
  if (!fortellisConfigured()) {
    return NextResponse.json({ error: "Fortellis credentials not configured" }, { status: 500 });
  }
  try {
    const subscriptions = await getSubscriptions();
    return NextResponse.json({ subscriptions });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load subscriptions" }, { status: 502 });
  }
}
