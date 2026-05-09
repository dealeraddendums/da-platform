import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/vehicles/models?make_id=123
 * Returns NHTSA models for the given make alphabetically.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const makeIdRaw = req.nextUrl.searchParams.get("make_id");
  const makeId = makeIdRaw ? parseInt(makeIdRaw, 10) : NaN;
  if (Number.isNaN(makeId)) {
    return NextResponse.json({ error: "make_id required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_models")
    .select("id, name, make_id")
    .eq("make_id", makeId)
    .order("name", { ascending: true });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
