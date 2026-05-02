import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: key + option + optional from/to. New: JWT + option + optional from/to.
// Returns how many times a specific option name appears for the dealer's vehicles.
// Data source: Supabase addendum_data (print compliance log)

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

  // addendum_data.dealer_id is the UUID; use legacy_dealer_id for text-based lookup
  let query = admin
    .from("addendum_data")
    .select("id", { count: "exact", head: true })
    .eq("legacy_dealer_id", claims.dealer_id)
    .ilike("item_name", option);

  if (from) query = query.gte("printed_at", from) as typeof query;
  if (to)   query = query.lte("printed_at", to) as typeof query;

  const { count, error: dbErr } = await query;

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  return NextResponse.json({ option, total_count: count ?? 0 });
}
