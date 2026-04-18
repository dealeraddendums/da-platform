import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { decodeVin } from "@/lib/vin-decoder";

/**
 * GET /api/vehicles/decode?vin=
 * Decodes a VIN using the full fallback chain.
 * Restricted to dealer_admin and dealer_user — admin roles are excluded.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  // Per spec: super_admin and group_admin cannot use the dealer-facing decoder
  if (claims.role === "super_admin" || claims.role === "group_admin") {
    return NextResponse.json(
      { error: "VIN decode is not available for admin roles" },
      { status: 403 }
    );
  }

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").trim().toUpperCase();
  if (!vin) {
    return NextResponse.json({ error: "vin param is required" }, { status: 400 });
  }
  if (vin.length !== 17) {
    return NextResponse.json({ error: "VIN must be exactly 17 characters" }, { status: 422 });
  }

  const result = await decodeVin(vin);

  if (result.decode_flagged) {
    console.log(`[vin-decode] flagged: ${vin} source=${result.source} confidence=${result.confidence}`);
  }

  return NextResponse.json(result);
}
