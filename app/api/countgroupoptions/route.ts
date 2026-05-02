import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: key + option + optional from/to (group resolved from key's dealer group).
// New: JWT + option + optional from/to; group resolved from Supabase dealers table.
// Data source: Supabase addendum_data

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const { searchParams } = req.nextUrl;
  const option = searchParams.get("option") ?? "";
  if (!option) {
    return NextResponse.json({ status: "failed", message: "API Key, Username, Option required." }, { status: 422 });
  }
  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const from = searchParams.get("from") ?? null;
  const to   = searchParams.get("to") ?? null;

  const admin = createAdminSupabaseClient();

  // Find this dealer's group_id
  const { data: dealerRow } = await admin
    .from("dealers")
    .select("group_id")
    .eq("dealer_id", claims.dealer_id)
    .maybeSingle();

  if (!dealerRow?.group_id) {
    return NextResponse.json({ option, total_count: 0 });
  }

  // Find all dealers in this group (text dealer_ids)
  const { data: groupDealers } = await admin
    .from("dealers")
    .select("dealer_id")
    .eq("group_id", dealerRow.group_id);

  const dealerIds = (groupDealers ?? []).map((d) => d.dealer_id);
  if (dealerIds.length === 0) {
    return NextResponse.json({ option, total_count: 0 });
  }

  // Count from Supabase addendum_data using legacy_dealer_id
  let query = admin
    .from("addendum_data")
    .select("id", { count: "exact", head: true })
    .in("legacy_dealer_id", dealerIds)
    .ilike("item_name", option);

  if (from) query = query.gte("printed_at", from) as typeof query;
  if (to)   query = query.lte("printed_at", to) as typeof query;

  const { count, error: dbErr } = await query;

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  return NextResponse.json({ option, total_count: count ?? 0 });
}
