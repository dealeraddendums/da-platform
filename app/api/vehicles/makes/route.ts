import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";

/**
 * GET /api/vehicles/makes
 * Returns all NHTSA makes alphabetically. Used by the rules dropdowns in the
 * Add/Edit Product modal — any authenticated user can read.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const admin = createAdminSupabaseClient();
  const { data, error: dbErr } = await admin
    .from("nhtsa_makes")
    .select("id, name")
    .order("name", { ascending: true });

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });
  return NextResponse.json({ data: data ?? [] });
}
