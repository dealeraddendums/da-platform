import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { PrintEvent } from "@/components/dashboard/ActivitySection";

/**
 * GET /api/dashboard/recent-prints
 * super_admin or group_admin. Returns last 50 print events for the live ticker.
 * Optional ?group_id=xxx to scope results to a specific group's dealers.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin" && claims.role !== "group_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const groupId = req.nextUrl.searchParams.get("group_id");

  // Security: group_admin can only query their own group
  if (groupId && claims.role === "group_admin" && claims.group_id !== groupId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If scoping to a group, fetch its text dealer_ids first
  let textDealerIds: string[] | null = null;
  if (groupId) {
    const { data: groupDealers } = await admin
      .from("dealers")
      .select("dealer_id")
      .eq("group_id", groupId);
    textDealerIds = (groupDealers ?? []).map(d => d.dealer_id as string);
    if (textDealerIds.length === 0) return NextResponse.json({ prints: [] });
  }

  let query = admin
    .from("print_history")
    .select(`
      id,
      dealer_id,
      created_at,
      dealers!print_history_dealer_id_fkey(id, name, account_type)
    `)
    .order("created_at", { ascending: false })
    .limit(50);

  if (textDealerIds) query = query.in("dealer_id", textDealerIds);

  const { data, error: dbErr } = await query;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

  const prints: PrintEvent[] = (data ?? [])
    .map((row) => {
      const dealer = (row.dealers as { id: string; name: string; account_type: string | null } | null);
      if (!dealer) return null;
      return {
        key: row.id as string,
        dealerUuid: dealer.id,
        dealerLegacyId: row.dealer_id as string,
        dealerName: dealer.name,
        accountType: dealer.account_type ?? null,
        printedAt: row.created_at as string,
      } satisfies PrintEvent;
    })
    .filter((p): p is PrintEvent => p !== null);

  return NextResponse.json({ prints });
}
