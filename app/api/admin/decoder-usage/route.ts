import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/decoder-usage?days=30|60|90
 * super_admin only. Aggregated VIN decode usage for the /admin/decoder Usage
 * tab. All aggregation happens in SQL via the vin_decode_usage_stats RPC
 * (migration 151) — the PostgREST 1000-row clamp never applies because raw
 * rows never leave the database. `days` drives the daily time series only;
 * summary cards + top dealers are fixed 30-day windows.
 */

type TopDealer = {
  dealer_id: string;
  decode_count: number;
  success_count: number;
  top_source: string | null;
  last_decode_at: string | null;
  dealer_name?: string;
};

type UsageStats = {
  daily: { day: string; count: number; successes: number }[];
  summary: {
    last7: number;
    last30: number;
    success30: number;
    top_source_30: string | null;
    first_at: string | null;
  };
  top_dealers: TopDealer[];
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const daysParam = parseInt(req.nextUrl.searchParams.get("days") ?? "60", 10);
  const days = [30, 60, 90].includes(daysParam) ? daysParam : 60;

  const admin = createAdminSupabaseClient();
  // RPC isn't in the generated Supabase types yet (migration 151).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: rpcErr } = await (admin as any).rpc("vin_decode_usage_stats", {
    p_days: days,
  });

  if (rpcErr) {
    console.error("[decoder-usage] RPC failed:", rpcErr.message);
    return NextResponse.json({ error: "Failed to load usage stats" }, { status: 500 });
  }

  const stats = data as UsageStats;

  // Resolve dealer names for the top-5 list (at most 5 ids — one query).
  const dealerIds = (stats.top_dealers ?? []).map((d) => d.dealer_id).filter(Boolean);
  if (dealerIds.length) {
    const { data: dealers } = await admin
      .from("dealers")
      .select("dealer_id, name")
      .in("dealer_id", dealerIds);
    const nameById = new Map((dealers ?? []).map((d) => [d.dealer_id, d.name as string]));
    for (const t of stats.top_dealers) {
      t.dealer_name = nameById.get(t.dealer_id) ?? t.dealer_id;
    }
  }

  return NextResponse.json({ days, ...stats });
}
