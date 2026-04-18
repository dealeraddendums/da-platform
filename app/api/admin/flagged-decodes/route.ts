import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role !== "super_admin") return NextResponse.json({ error: "super_admin only" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const source = sp.get("source");

  const admin = createAdminSupabaseClient();
  let query = admin
    .from("dealer_vehicles")
    .select("id,dealer_id,stock_number,vin,make,model,year,decode_source,decode_flagged,date_added")
    .eq("decode_flagged", true)
    .order("date_added", { ascending: false })
    .limit(200);

  if (source && source !== "all") {
    query = query.eq("decode_source", source);
  }

  const { data, error: dbErr } = await query;
  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
