import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { BuyersGuideDefaults } from "@/lib/db";
import { buildBuyersGuideHtml } from "@/lib/buyers-guide-html";
import { renderPdf } from "@/lib/pdf-renderer";
import { uploadPdf } from "@/lib/s3-upload";
import JSZip from "jszip";

/**
 * POST /api/pdf/buyers-guide
 * Generates a 2-page FTC Buyer's Guide PDF.
 * Body: { vehicleId, language?, both?, warranty? }
 * - language: 'en' | 'es' (default 'en')
 * - both: true → returns a ZIP with EN + ES PDFs
 * - warranty: BuyersGuideDefaults overrides (optional, falls back to dealer_settings)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
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
    .select("name, address, city, state, zip, phone")
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

  async function generateOneLang(lang: 'en' | 'es'): Promise<{ url: string; buffer: Buffer }> {
    const html = buildBuyersGuideHtml({ language: lang, vehicle: vehicleData, dealer: dealerData, warranty });
    const buffer = await renderPdf(html, 'buyers_guide', { allPages: true });
    const key = `${dvDealerId}/${vehicleId}/buyers_guide_${lang}_${Date.now()}.pdf`;
    const url = await uploadPdf(buffer, key);
    return { url, buffer };
  }

  // ── Log helper ────────────────────────────────────────────────────────────
  async function logPrint(pdfUrl: string) {
    await admin.from("print_history").insert({
      vehicle_id: vehicleId,
      dealer_id: dvDealerId,
      document_type: "buyer_guide",
      printed_by: claimsSub,
      pdf_url: pdfUrl,
    });
  }

  // ── Generate ──────────────────────────────────────────────────────────────
  if (both) {
    const [en, es] = await Promise.all([generateOneLang('en'), generateOneLang('es')]);
    await logPrint(en.url);

    const zip = new JSZip();
    const base = `${dv.make ?? 'vehicle'}_${dv.year ?? ''}_buyers_guide`.replace(/\s+/g, '_');
    zip.file(`${base}_english.pdf`, en.buffer);
    zip.file(`${base}_spanish.pdf`, es.buffer);
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

  const { url } = await generateOneLang(language);
  await logPrint(url);
  return NextResponse.json({ url });
}
