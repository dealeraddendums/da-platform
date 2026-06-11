import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { BuyersGuideDefaults } from "@/lib/db";
import { buildPdfKey } from "@/lib/s3-upload";
import { useService as usePdfService, renderBuyerGuideViaService } from "@/lib/pdf-service-client";
import { createPendingPrint, recordPrint, type PrintRecordPayload } from "@/lib/record-print";
import { getBuyersGuidePdfBytes } from "@/lib/buyers-guide-storage";
import type { BgKey } from "@/lib/buyers-guide-constants";
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
  const dvVin = dv.vin ?? null;
  const claimsSub = claims.sub;

  const dealerUuid = dealer?.id ?? null;

  async function generateOneLang(lang: 'en' | 'es', s3Key: string): Promise<Buffer> {
    // Phase 10b / E.2: service is the only render path. da-platform
    // pre-fetches the FTC background from Supabase Storage and ships
    // the bytes over so the service stays Supabase-free.
    if (!usePdfService()) {
      throw new Error("PDF service not configured (PDF_SERVICE_URL + PDF_SERVICE_API_KEY required)");
    }
    const isImplied = warranty.warranty_type === 'implied_only';
    const bgKey = `${lang === 'es' ? 'spanish' : 'english'}-${isImplied ? 'implied' : 'as-is-warranty'}` as BgKey;
    const srcPdfBytes = await getBuyersGuidePdfBytes(bgKey, dealerUuid);
    const result = await renderBuyerGuideViaService(srcPdfBytes, {
      language: lang,
      vehicle: vehicleData,
      dealer: dealerData,
      warranty,
    }, s3Key);
    return result.buffer;
  }

  // Print recording is DEFERRED to the user's Send/Download click (POST
  // /api/print/confirm with the X-Print-Token below) — generating a preview
  // no longer logs a print. Fallback: if the stash fails (migration 099 not
  // applied), record immediately — the legacy generation-time behavior.
  async function stashPrint(s3Key: string): Promise<string | null> {
    const payload: PrintRecordPayload = {
      source: "buyer_guide",
      vehicleId,
      dealerTextId: dvDealerId,
      dealerUuid,
      vin: dvVin,
      stockNumber: null,
      docType: "buyer_guide",
      s3Key,
      options: [],
    };
    const token = await createPendingPrint(admin, { dealerTextId: dvDealerId, createdBy: claimsSub, payloads: [payload] });
    if (!token) {
      void recordPrint(admin, claimsSub, payload).catch(err =>
        console.error("[buyers-guide] fallback logging error:", err instanceof Error ? err.message : err)
      );
    }
    return token;
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  if (both) {
    // Compute keys up front so the service uploads to the canonical
    // {VIN}_buyers_guide.pdf path directly. English is canonical
    // (logged to print_history); Spanish gets a sibling key so the
    // service still uploads it, but we don't log a second row.
    const enKey = buildPdfKey({
      internalId: dealer?.internal_id ?? null,
      dealerIdFallback: dvDealerId,
      vehicleUuid: vehicleId,
      vin: dv.vin,
      docType: 'buyer_guide',
    });
    const esKey = enKey.replace(/_buyers_guide\.pdf$/, '_buyers_guide_es.pdf');
    const [enBuffer, esBuffer] = await Promise.all([
      generateOneLang('en', enKey),
      generateOneLang('es', esKey),
    ]);
    const zipToken = await stashPrint(enKey);

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
        ...(zipToken ? { "X-Print-Token": zipToken } : {}),
      },
    });
  }

  const s3Key = buildPdfKey({
    internalId: dealer?.internal_id ?? null,
    dealerIdFallback: dvDealerId,
    vehicleUuid: vehicleId,
    vin: dv.vin,
    docType: 'buyer_guide',
  });
  const buffer = await generateOneLang(language, s3Key);
  const printToken = await stashPrint(s3Key);
  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(buffer.length),
      ...(printToken ? { "X-Print-Token": printToken } : {}),
    },
  });
}
