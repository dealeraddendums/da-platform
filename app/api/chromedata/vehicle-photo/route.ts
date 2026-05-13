import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { resolveChromeVehicleImage } from "@/lib/chromedata";

/**
 * GET /api/chromedata/vehicle-photo?vin=...&color=...
 *
 * Server-side resolver for the Vehicle Photo widget. Hits ChromeData (SOAP +
 * MediaGallery JSON) on the first lookup, then serves from the Supabase
 * cache for subsequent requests of the same (vin, color) pair.
 *
 * Auth: any authenticated user (the result is per-vehicle metadata, not
 * dealer-sensitive). Restrict to authenticated only to keep ChromeData
 * credentials from being trivially exploitable by anonymous callers.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { error } = await requireAuth();
  if (error) return error;

  const vin = req.nextUrl.searchParams.get("vin")?.trim() ?? "";
  const color = req.nextUrl.searchParams.get("color")?.trim() ?? "";
  if (!vin) {
    return NextResponse.json({ error: "vin is required" }, { status: 400 });
  }

  const result = await resolveChromeVehicleImage(vin, color);
  return NextResponse.json(result);
}
