import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

// Legacy: key + username. New: Supabase JWT.
// Returns list of dealer IDs and names scoped by role.
// Data source: Supabase dealers table

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();

  if (claims.role === "super_admin") {
    const { data, error: dbErr } = await admin
      .from("dealers")
      .select("legacy_id, dealer_id, name")
      .eq("active", true)
      .order("name");
    if (dbErr) return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
    return NextResponse.json((data ?? []).map(d => ({
      _ID: d.legacy_id,
      DEALER_ID: d.dealer_id,
      DEALER_NAME: d.name,
    })));
  } else {
    if (!claims.dealer_id) {
      return NextResponse.json({ status: "failed", message: "No dealer assigned." }, { status: 403 });
    }
    const { data, error: dbErr } = await admin
      .from("dealers")
      .select("legacy_id, dealer_id, name")
      .eq("dealer_id", claims.dealer_id)
      .limit(1);
    if (dbErr) return NextResponse.json({ status: "failed", message: dbErr.message }, { status: 500 });
    return NextResponse.json((data ?? []).map(d => ({
      _ID: d.legacy_id,
      DEALER_ID: d.dealer_id,
      DEALER_NAME: d.name,
    })));
  }
}
