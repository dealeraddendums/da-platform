import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { FUEL_RULE_OPTIONS } from "@/lib/fuel-rule";

/**
 * GET /api/vehicles/fuel-types
 *
 * Returns the curated canonical fuel categories for the Fuel rule dropdown:
 * { data: [{ label, keywords }] }. STATIC — it does NOT scan dealer_vehicles
 * (that column is ~95% feed garbage across 428 distinct values). The UI shows
 * the clean labels; selecting one stores that category's lowercase substring
 * keywords into the `fuel` rule CSV, which the matcher uses to catch feed
 * variants. See lib/fuel-rule.ts. (The distinct_vehicle_fuels() function from
 * migration 097 is retained for ad-hoc auditing only — no longer the source.)
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;
  return NextResponse.json({ data: FUEL_RULE_OPTIONS });
}
