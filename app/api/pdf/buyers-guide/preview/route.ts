import { NextRequest, NextResponse } from "next/server";
import { buildBuyersGuidePdf } from "@/lib/buyers-guide-pdf";

/**
 * GET /api/pdf/buyers-guide/preview?lang=en|es&warranty=as_is|implied_only|full|limited
 * Returns a test-filled PDF for visual coordinate verification. No auth required in dev.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const lang = (searchParams.get("lang") ?? "en") as "en" | "es";
  const warrantyType = (searchParams.get("warranty") ?? "as_is") as "as_is" | "implied_only" | "full" | "limited";

  const buffer = await buildBuyersGuidePdf({
    language: lang,
    vehicle: {
      make: "Toyota",
      model: "Camry",
      year: "2021",
      vin: "4T1BF1FK5CU123456",
    },
    dealer: {
      name: "Test Motors of Springfield",
      address: "123 Auto Drive",
      city: "Springfield",
      state: "IL",
      zip: "62701",
      phone: "(217) 555-0100",
      email: "sales@testmotors.com",
    },
    warranty: {
      warranty_type: warrantyType,
      labor_pct: warrantyType === "limited" ? 50 : undefined,
      parts_pct: warrantyType === "limited" ? 50 : undefined,
      systems_covered: warrantyType === "limited" ? "Powertrain, Engine, Transmission" : undefined,
      duration: warrantyType === "limited" ? "30 days or 1,000 miles" : undefined,
      non_dealer_warranties: ["mfr_new"],
      service_contract: true,
      dealer_email: "sales@testmotors.com",
    },
  });

  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="buyers-guide-preview-${lang}-${warrantyType}.pdf"`,
    },
  });
}
