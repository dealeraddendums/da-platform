import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { decodeVin } from "@/lib/vin-decoder";
import { splitDecodedOptions } from "@/lib/decode-options";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/decoder-test?vin=
 * super_admin only. Backs the /admin/decoder "Test Decode" tab: runs the SAME
 * decodeVin() chain as /api/vehicles/decode (override → pattern → live vPIC →
 * dealer_vehicles → WMI partial) and returns the result plus the dropdown
 * candidates the Add Vehicle modal would offer for the multi-value fields.
 *
 * Read-only preview: creates no vehicle and needs no dealer context.
 * Deliberately NOT logged to vin_decode_log, so admin test decodes never move
 * the Usage tab or its dealer attribution.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireSuperAdmin();
  if (error) return error;

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").trim().toUpperCase();
  if (!vin) return NextResponse.json({ error: "Enter a VIN" }, { status: 400 });
  if (vin.length !== 17) {
    return NextResponse.json({ error: "VIN must be exactly 17 characters" }, { status: 422 });
  }

  const started = Date.now();
  try {
    const result = await decodeVin(vin);
    return NextResponse.json({
      result,
      candidates: {
        trim: splitDecodedOptions(result.trim),
        body_style: splitDecodedOptions(result.body_style),
        drivetrain: splitDecodedOptions(result.drivetrain),
      },
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Decode failed: ${msg}` }, { status: 500 });
  }
}
