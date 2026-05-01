import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { PrintEvent } from "@/components/dashboard/ActivitySection";

/**
 * GET /api/dashboard/recent-prints
 * super_admin only. Returns last 50 print events with dealer info for the live ticker.
 */
export async function GET(): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  // print_history has one row per print job (dealer_id is legacy text FK → dealers.dealer_id)
  const { data, error: dbErr } = await admin
    .from("print_history")
    .select(`
      id,
      dealer_id,
      created_at,
      dealers!print_history_dealer_id_fkey(id, name, active)
    `)
    .order("created_at", { ascending: false })
    .limit(50);

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  const prints: PrintEvent[] = (data ?? [])
    .map((row) => {
      const dealer = (row.dealers as { id: string; name: string; active: boolean } | null);
      if (!dealer) return null;
      return {
        key: row.id as string,
        dealerUuid: dealer.id,
        dealerLegacyId: row.dealer_id as string,
        dealerName: dealer.name,
        dealerActive: dealer.active,
        printedAt: row.created_at as string,
      } satisfies PrintEvent;
    })
    .filter((p): p is PrintEvent => p !== null);

  return NextResponse.json({ prints });
}
