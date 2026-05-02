import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: required key (resolves dealer_id). New: Supabase JWT.
// Data source: Supabase addendum_library

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  if (!claims.dealer_id) {
    return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("addendum_library")
    .select("dealer_id, option_name, description, item_price, models, trims, body_styles, created_at")
    .eq("dealer_id", claims.dealer_id)
    .eq("active", true)
    .order("sort_order", { ascending: true });

  if (dbErr) {
    return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
  }

  // Map to legacy column names
  const mapped = (data ?? []).map((r) => ({
    DEALER_ID: r.dealer_id,
    ITEM_NAME: r.option_name,
    ITEM_DESCRIPTION: r.description ?? "",
    ITEM_PRICE: r.item_price ?? "NC",
    MODELS: r.models ?? "",
    TRIMS: r.trims ?? "",
    BODY_STYLES: r.body_styles ?? "",
    created_at: r.created_at,
  }));

  return NextResponse.json(mapped);
}
