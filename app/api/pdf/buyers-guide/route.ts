import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { BuyersGuideDefaults } from "@/lib/db";
import { buildBuyersGuidePdf } from "@/lib/buyers-guide-pdf";
import { uploadPdf, buildPdfKey } from "@/lib/s3-upload";
import JSZip from "jszip";

/**
 * POST /api/pdf/buyers-guide
 * Generates a 2-page FTC Buyer's Guide PDF using pdf-lib overlay on official FTC backgrounds.
 * Body: { vehicleId, language?, both?, warranty? }
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    return await handleBuyersGuide(req);
  } catch (err) {
    // Any unhandled exception (pdf-lib failure, S3 download, missing
    // assets, Supabase outage, etc.) lands here so the client always sees
    // valid JSON. Without this, Next.js' default error page returns HTML
    // and the modal's `await res.json()` blows up on "Unexpected token <".
    const msg = err instanceof Error ? err.message : "Buyer's Guide generation failed";
    console.error("[buyers-guide] uncaught:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handleBuyersGuide(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    vehicleId: string;
    language?: 'en' | 'es';
    both?: boolean;
    warranty?: Partial<BuyersGuideDefaults>;
  };
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { vehicleId, language = 'en', both = false, warranty: warrantyOverrides } = body;
  if (!vehicleId) return NextResponse.json({ error: "vehicleId required" }, { status: 400 });

  const admin = createAdminSupabaseClient();

  // ── Vehicle ───────────────────────────────────────────────────────────────
  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("dealer_id, vin, make, model, year")
    .eq("id", vehicleId)
    .maybeSingle();

  if (!dv) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

  if ((claims.role === "dealer_admin" || claims.role === "dealer_user") && dv.dealer_id !== claims.dealer_id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ── Dealer ────────────────────────────────────────────────────────────────
  const { data: dealer } = await admin
    .from("dealers")
    .select("id, internal_id, name, address, city, state, zip, phone")
    .eq("dealer_id", dv.dealer_id)
    .maybeSingle();

  // ── Warranty defaults ─────────────────────────────────────────────────────
  const { data: settings } = await admin
    .from("dealer_settings")
    .select("buyers_guide_defaults")
    .eq("dealer_id", dv.dealer_id)
    .maybeSingle<{ buyers_guide_defaults: BuyersGuideDefaults | null }>();

  const savedDefaults = settings?.buyers_guide_defaults ?? null;
  const warranty: BuyersGuideDefaults = {
    warranty_type: 'as_is',
    ...savedDefaults,
    ...warrantyOverrides,
  };

  const vehicleData = {
    make: dv.make ?? null,
    model: dv.model ?? null,
    year: dv.year ? String(dv.year) : null,
    vin: dv.vin ?? null,
  };

  const dealerData = {
    name: dealer?.name ?? null,
    address: dealer?.address ?? null,
    city: dealer?.city ?? null,
    state: dealer?.state ?? null,
    zip: dealer?.zip ?? null,
    phone: dealer?.phone ?? null,
    email: warranty.dealer_email ?? null,
  };

  const dvDealerId = dv.dealer_id;
  const claimsSub = claims.sub;

  const dealerUuid = dealer?.id ?? null;

  function generateOneLang(lang: 'en' | 'es'): Promise<Buffer> {
    return buildBuyersGuidePdf({ language: lang, dealerUuid, vehicle: vehicleData, dealer: dealerData, warranty });
  }

  async function logPrint(buffer: Buffer, s3Key: string): Promise<void> {
    let pdfUrl = "";
    try {
      pdfUrl = await uploadPdf(buffer, s3Key);
    } catch (err) {
      console.error("[buyers-guide] S3 upload failed:", err instanceof Error ? err.message : err);
    }
    await admin.from("print_history").insert({
      vehicle_id: vehicleId,
      dealer_id: dvDealerId,
      document_type: "buyer_guide",
      printed_by: claimsSub,
      pdf_url: pdfUrl || null,
    });
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  if (both) {
    const [enBuffer, esBuffer] = await Promise.all([generateOneLang('en'), generateOneLang('es')]);
    // Save the English buyer's guide to the canonical {VIN}_buyers_guide.pdf slot.
    // Spanish is delivered in the zip but we keep one canonical buyer's guide per vehicle.
    const enKey = buildPdfKey({
      internalId: dealer?.internal_id ?? null,
      dealerIdFallback: dvDealerId,
      vehicleUuid: vehicleId,
      vin: dv.vin,
      docType: 'buyer_guide',
    });
    void logPrint(enBuffer, enKey).catch(err =>
      console.error("[buyers-guide] background logging error:", err instanceof Error ? err.message : err)
    );

    const zip = new JSZip();
    const base = `${dv.make ?? 'vehicle'}_${dv.year ?? ''}_buyers_guide`.replace(/\s+/g, '_');
    zip.file(`${base}_english.pdf`, enBuffer);
    zip.file(`${base}_spanish.pdf`, esBuffer);
    const zipBuffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });

    return new NextResponse(zipBuffer as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${base}_en_es.zip"`,
        "Content-Length": String((zipBuffer as ArrayBuffer).byteLength),
      },
    });
  }

  const buffer = await generateOneLang(language);
  const s3Key = buildPdfKey({
    internalId: dealer?.internal_id ?? null,
    dealerIdFallback: dvDealerId,
    vehicleUuid: vehicleId,
    vin: dv.vin,
    docType: 'buyer_guide',
  });
  void logPrint(buffer, s3Key).catch(err =>
    console.error("[buyers-guide] background logging error:", err instanceof Error ? err.message : err)
  );
  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.length),
    },
  });
}
