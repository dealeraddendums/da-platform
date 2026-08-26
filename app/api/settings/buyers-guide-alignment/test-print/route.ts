import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { buildBuyersGuidePdf, type BgPreprintedOffsets } from "@/lib/buyers-guide-pdf";
import type { BuyersGuideDefaults } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/buyers-guide-alignment/test-print — calibration aid.
 * Renders a DATA-ONLY Buyer's Guide with the offsets from the request body
 * (not the saved config — so the operator can iterate before saving) using a
 * SAMPLE vehicle + the dealer's real info/warranty defaults, and returns the
 * PDF directly. The operator prints it on their label stock, checks the
 * registration, nudges, reprints. Never recorded as a print.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (!["super_admin", "dealer_admin", "group_admin"].includes(claims.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { dealer_id?: string; language?: string; global?: { x?: number; y?: number }; fields?: Record<string, { x?: number; y?: number }>; withBackground?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const dealerTextId = claims.role === "dealer_admin" ? (claims.dealer_id ?? null) : (body.dealer_id?.trim() || claims.dealer_id || null);
  if (!dealerTextId) return NextResponse.json({ error: "dealer_id required" }, { status: 400 });
  if (claims.role !== "super_admin") {
    const authz = await authorizeDealerAction(claims, dealerTextId);
    if (!authz.ok) return authz.response;
  }

  const admin = createAdminSupabaseClient();
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, name, address, city, state, zip, phone")
    .eq("dealer_id", dealerTextId)
    .maybeSingle();
  if (!dealer) return NextResponse.json({ error: "Dealer not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (admin as any)
    .from("dealer_settings")
    .select("buyers_guide_defaults")
    .eq("dealer_id", dealerTextId)
    .maybeSingle();
  const warranty: BuyersGuideDefaults = { warranty_type: "as_is", ...((settings?.buyers_guide_defaults as BuyersGuideDefaults | null) ?? {}) };

  const preprinted: BgPreprintedOffsets = {
    global: { x: Number(body.global?.x) || 0, y: Number(body.global?.y) || 0 },
    fields: body.fields ?? {},
  };

  const pdf = await buildBuyersGuidePdf({
    language: body.language === "es" ? "es" : "en",
    dealerUuid: dealer.id,
    // withBackground=true renders the FULL guide (FTC background + data) with
    // the same offsets — useful on-screen to sanity-check placement against
    // DA's own form before burning label stock.
    preprinted: body.withBackground === true ? null : preprinted,
    vehicle: { make: "SAMPLE MAKE", model: "SAMPLE MODEL", year: "2026", vin: "SAMPLE00000000000" },
    dealer: { name: dealer.name, address: dealer.address, city: dealer.city, state: dealer.state, zip: dealer.zip, phone: dealer.phone },
    warranty,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="buyers-guide-alignment-test.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
