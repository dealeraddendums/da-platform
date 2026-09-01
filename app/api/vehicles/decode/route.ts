import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { decodeVin } from "@/lib/vin-decoder";
import { logVinDecode } from "@/lib/vin-decode-log";

/**
 * GET /api/vehicles/decode?vin=
 * Decodes a VIN using the full fallback chain. Any authenticated role
 * (2026-08-14): the original admin-role 403 broke the white-glove flow —
 * a GHOSTED super_admin keeps super_admin claims, so Allan operating a
 * dealer's Add Vehicle modal got 403 on every VIN, which the modal rendered
 * as "VIN not found" (the 2027 S-Class incident — the decoder itself,
 * including the live-vPIC fallback, was working the whole time). Decode is
 * read-only public NHTSA data; there is nothing to protect from admins.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").trim().toUpperCase();
  if (!vin) {
    return NextResponse.json({ error: "vin param is required" }, { status: 400 });
  }
  if (vin.length !== 17) {
    return NextResponse.json({ error: "VIN must be exactly 17 characters" }, { status: 422 });
  }

  const started = Date.now();
  const result = await decodeVin(vin);

  // Usage logging (migration 151) — fire-and-forget, never affects the decode.
  // success = a real decode stage answered; wmi_partial/failed are misses.
  logVinDecode(
    claims,
    vin,
    result.resolved_by,
    result.resolved_by !== "failed" && result.resolved_by !== "wmi_partial",
    Date.now() - started,
  );

  if (result.decode_flagged) {
    console.log(`[vin-decode] flagged: ${vin} source=${result.source} confidence=${result.confidence}`);
  }

  return NextResponse.json(result);
}
