import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

// JWT-authenticated. Calls NHTSA vPIC and returns decoded vehicle data.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  void claims;

  const vin = (req.nextUrl.searchParams.get("vin") ?? "").toUpperCase();
  if (!vin) {
    return NextResponse.json({ status: "failed", message: "VIN is required." }, { status: 422 });
  }

  try {
    const nhtsaUrl = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValues/${encodeURIComponent(vin)}?format=json`;
    const res = await fetch(nhtsaUrl, { next: { revalidate: 86400 } });

    if (!res.ok) {
      return NextResponse.json({ status: "failed", message: "NHTSA API unavailable." }, { status: 503 });
    }

    const json = await res.json() as { Results: Record<string, string>[]; Count: number };

    if (!json.Results?.length) {
      return NextResponse.json({ status: "failed", message: "VIN not found." }, { status: 404 });
    }

    // Filter empty values; keep "0" (Error Code 0 = success) and all non-empty strings
    const raw = json.Results[0];
    const data: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val !== "" && val !== null && val !== undefined) {
        data[key] = val;
      }
    }

    return NextResponse.json({ status: "success", vin, source: "NHTSA vPIC", data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ status: "failed", message: msg }, { status: 503 });
  }
}
