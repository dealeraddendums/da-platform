import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert, AddendumHistoryInsert, AddendumDataInsert, DealerSettingsRow } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { renderPdf } from "@/lib/pdf-renderer";
import { uploadPdf } from "@/lib/s3-upload";
import {
  BG_DEFAULT,
  IS_BG_DEFAULT,
  LAYOUT,
  LAYOUT_INFOSHEET,
  makeWidget,
} from "@/components/builder/constants";
import { getGroupOptionsForDealer, getGroupDisclaimer } from "@/lib/options-engine";
import { resolveCustomTextTokens } from "@/lib/token-resolver";
import { generateVehicleContent } from "@/lib/ai-content";
import QRCode from "qrcode";
import type { Widget, PaperSize } from "@/components/builder/types";

/**
 * POST /api/pdf/generate
 * Generates a PDF for a vehicle stored in dealer_vehicles (Supabase).
 * All data — vehicle, dealer, options — comes from Supabase only.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    dealerVehicleId?: string;
    widgets?: Widget[];
    paperSize?: PaperSize;
    fontScale?: number;
    bgUrl?: string;
    docType?: "addendum" | "infosheet" | "buyer_guide";
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { dealerVehicleId, widgets: inWidgets, paperSize: reqPaperSize = "standard", fontScale = 1.0, docType = "addendum" } = body;
  const paperSize = reqPaperSize;

  console.log("[pdf/generate] called — dealerVehicleId:", dealerVehicleId, "docType:", docType, "role:", claims.role, "dealer_id:", claims.dealer_id);

  if (!dealerVehicleId) {
    console.error("[pdf/generate] missing dealerVehicleId — body keys:", Object.keys(body));
    return NextResponse.json({ error: "dealerVehicleId required" }, { status: 400 });
  }

  try {
    const admin = createAdminSupabaseClient();

    // ── Vehicle from Supabase ─────────────────────────────────────────────────
    const { data: dv } = await admin
      .from("dealer_vehicles")
      .select("*")
      .eq("id", dealerVehicleId)
      .maybeSingle();
    if (!dv) {
      return NextResponse.json({ error: "Vehicle not found in dealer inventory" }, { status: 404 });
    }

    const effectiveDealerId = (claims as Record<string, unknown>).impersonating_dealer_id as string | null
      ?? claims.dealer_id;
    const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
    if (isDealer && effectiveDealerId && dv.dealer_id !== effectiveDealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // ── Dealer from Supabase ──────────────────────────────────────────────────
    // dealer_vehicles.dealer_id is the TEXT dealer_id (matches dealers.dealer_id, not dealers.id UUID)
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, dealer_id, name, address, city, state, zip, phone, logo_url")
      .eq("dealer_id", dv.dealer_id)
      .maybeSingle();

    // dealer.dealer_id is the text ID used by group options / disclaimers
    const textDealerId = dealer?.dealer_id ?? "";

    // ── Dealer QR URL template ────────────────────────────────────────────────
    let dealerQrTemplate: string | null = null;
    try {
      const { data: dealerQrSettings } = await admin
        .from("dealer_settings")
        .select("qr_url_template")
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle<{ qr_url_template: string | null }>();
      dealerQrTemplate = dealerQrSettings?.qr_url_template ?? null;
    } catch { /* column may not exist until migration 034 is applied */ }

    // ── Options from Supabase ─────────────────────────────────────────────────
    // Check per-vehicle UUID first; fall back to legacy '0' sentinel
    let { data: optionRows } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", dealerVehicleId)
      .eq("dealer_id", dv.dealer_id)
      .order("sort_order");

    if (!optionRows || optionRows.length === 0) {
      const { data: legacyRows } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", "0")
        .eq("dealer_id", dv.dealer_id)
        .order("sort_order");
      optionRows = legacyRows;
    }

    // For options missing a description, fall back to addendum_library by name
    const nullDescNames = (optionRows ?? [])
      .filter(r => !r.description)
      .map(r => r.option_name as string);
    const libDescMap: Record<string, string | null> = {};
    if (nullDescNames.length > 0) {
      const { data: libRows } = await admin
        .from("addendum_library")
        .select("option_name, description")
        .in("option_name", nullDescNames)
        .not("description", "is", null);
      for (const lr of libRows ?? []) {
        if (lr.description) libDescMap[lr.option_name as string] = lr.description as string;
      }
    }

    const groupOpts = await getGroupOptionsForDealer(textDealerId);

    const options = [
      ...groupOpts.map(g => ({
        option_name: g.option_name,
        option_price: g.option_price,
        description: null as string | null,
        active: true as const,
      })),
      ...(optionRows ?? []).map(r => ({
        ...r,
        description: r.description ?? libDescMap[r.option_name as string] ?? null,
      })),
    ];

    const disclaimer = await getGroupDisclaimer(textDealerId, dealer?.state ?? null, docType);

    // ── Vehicle data shaped for PDF renderer ──────────────────────────────────
    const vehicleData = {
      id: 0 as const,
      DEALER_ID: dv.dealer_id,
      VIN_NUMBER: dv.vin ?? "",
      STOCK_NUMBER: dv.stock_number,
      YEAR: dv.year ? String(dv.year) : null,
      MAKE: dv.make,
      MODEL: dv.model,
      TRIM: dv.trim,
      BODYSTYLE: dv.body_style,
      EXT_COLOR: dv.exterior_color,
      INT_COLOR: dv.interior_color,
      ENGINE: dv.engine,
      FUEL: null,
      DRIVETRAIN: dv.drivetrain,
      TRANSMISSION: dv.transmission,
      MILEAGE: dv.mileage ? String(dv.mileage) : null,
      DATE_IN_STOCK: dv.date_added,
      STATUS: "1" as const,
      MSRP: dv.msrp ? String(dv.msrp) : null,
      NEW_USED: dv.condition === "Used" ? "Used" : "New",
      CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
      OPTIONS: null,
      PHOTOS: null,
      DESCRIPTION: dv.description,
      PRINT_STATUS: "0" as const,
      HMPG: null,
      CMPG: null,
      MPG: null,
    };

    // ── Load dealer's saved default template from dealer_settings ────────────
    // Only runs when no widgets were supplied by the caller (i.e. Print Now,
    // not a Builder print which passes its own widget layout).
    let savedTemplateWidgets: Widget[] | null = null;
    let savedTemplateBgUrl: string | undefined;
    let savedTemplateFontScale: number | undefined;
    let savedTemplatePaperSize: PaperSize | undefined;

    if (!inWidgets || inWidgets.length === 0) {
      const { data: settings } = await admin
        .from("dealer_settings")
        .select([
          "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
          "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
          "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
        ].join(", "))
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle<DealerSettingsRow>();

      if (settings) {
        const condKey = dv.condition === "New" ? "new" : dv.condition === "Used" ? "used" : "cpo";
        const docKey = docType === "buyer_guide" ? "buyersguide" : docType;
        const col = `default_${docKey}_${condKey}` as keyof DealerSettingsRow;
        const templateId = settings[col] as string | null;

        if (templateId) {
          const { data: tmpl } = await admin
            .from("templates")
            .select("template_json")
            .eq("id", templateId)
            .maybeSingle<{ template_json: Record<string, unknown> }>();

          if (tmpl?.template_json) {
            const tj = tmpl.template_json as {
              widgets?: Record<string, Widget>;
              bgUrl?: string;
              fontScale?: number;
              paperSize?: string;
            };
            if (tj.widgets && Object.keys(tj.widgets).length > 0) {
              savedTemplateWidgets = Object.values(tj.widgets);
            }
            if (tj.bgUrl) savedTemplateBgUrl = tj.bgUrl;
            if (typeof tj.fontScale === "number") savedTemplateFontScale = tj.fontScale;
            if (tj.paperSize) savedTemplatePaperSize = tj.paperSize as PaperSize;
          }
        }
      }
    }

    // ── Resolve custom paper size dimensions ──────────────────────────────────
    let customPaperDims: { widthIn: number; heightIn: number } | undefined;
    let customSizeBgUrl: string | undefined;
    const knownSizes = new Set(['standard', 'narrow', 'infosheet']);
    const effectivePaperSizeStr = savedTemplatePaperSize ?? paperSize;
    if (!knownSizes.has(effectivePaperSizeStr)) {
      const { data: cs } = await admin
        .from("dealer_custom_sizes")
        .select("width_in, height_in, background_url")
        .eq("id", effectivePaperSizeStr)
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle();
      if (cs) {
        customPaperDims = { widthIn: Number(cs.width_in), heightIn: Number(cs.height_in) };
        if (cs.background_url) customSizeBgUrl = cs.background_url;
      }
    }

    // ── Build widget layout ───────────────────────────────────────────────────
    const effectivePaperSize: PaperSize = (knownSizes.has(effectivePaperSizeStr) ? effectivePaperSizeStr : 'standard') as PaperSize;
    const effectiveFontScale = savedTemplateFontScale ?? fontScale;
    const isInfosheet = effectivePaperSize === "infosheet";
    let widgets: Widget[];

    if (inWidgets && inWidgets.length > 0) {
      widgets = inWidgets;
    } else if (savedTemplateWidgets && savedTemplateWidgets.length > 0) {
      widgets = savedTemplateWidgets;
    } else {
      const layout = isInfosheet ? LAYOUT_INFOSHEET : LAYOUT;
      const order = isInfosheet
        ? ["logo", "vehicle", "description", "features", "askbar", "qrcode", "barcode", "dealer", "customtext"]
        : ["logo", "vehicle", "msrp", "options", "subtotal", "askbar", "dealer", "infobox"];
      let nid = 1;
      widgets = order
        .filter(t => layout[t])
        .map(t => {
          const id = "w" + nid++;
          const w = makeWidget(t, id, undefined, undefined, undefined, undefined, isInfosheet);
          if (t === "msrp" && vehicleData.MSRP) {
            const msrp = parseFloat(vehicleData.MSRP);
            if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
          }
          if (t === "dealer") {
            const lines = [
              dealer?.name,
              dealer?.address,
              [dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(" "),
              dealer?.phone,
            ].filter(Boolean);
            if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
          }
          if (t === "logo" && dealer?.logo_url) {
            w.d = { ...w.d, imgUrl: dealer.logo_url };
          }
          if (t === "askbar") {
            const msrp = vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : 0;
            const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
            if (msrp + optTotal > 0) w.d = { ...w.d, value: `$${(msrp + optTotal).toLocaleString()}` };
          }
          if (t === "subtotal") {
            const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
            if (optTotal > 0) w.d = { ...w.d, value: `$${optTotal.toLocaleString()}` };
          }
          return w;
        });
    }

    // ── Generate QR codes for infobox QR widgets ─────────────────────────────
    const qrWidgets = widgets.filter(
      w => w.type === 'infobox' && (w.d.ibType as string) === 'qr'
    );
    if (qrWidgets.length > 0) {
      widgets = await Promise.all(widgets.map(async w => {
        if (w.type !== 'infobox' || (w.d.ibType as string) !== 'qr') return w;
        // Priority: vdp_link > widget template > dealer template
        const vin  = dv.vin ?? '';
        const stock = dv.stock_number ?? '';
        let qrUrl = dv.vdp_link
          ?? ((w.d.qrUrlTemplate as string) || dealerQrTemplate
            ? ((w.d.qrUrlTemplate as string) || dealerQrTemplate as string)
                .replace('[VIN]', vin).replace('[STOCK]', stock)
            : null);
        if (!qrUrl) return w;
        try {
          const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
          return { ...w, d: { ...w.d, imgUrl: dataUrl } };
        } catch { return w; }
      }));
    }

    // ── Resolve {{token}} patterns in customtext widgets ─────────────────────
    const tokenWidgets = widgets.filter(
      w => w.type === 'customtext' && ((w.d.text as string) || '').includes('{{')
    );
    if (tokenWidgets.length > 0) {
      let aiContent: { description: string; features: [string, string][] } | null = null;
      const needsAi = tokenWidgets.some(w => ((w.d.text as string) || '').includes('{{ai.'));
      if (needsAi && vehicleData.VIN_NUMBER) {
        const { data: cached } = await admin
          .from('ai_content_cache')
          .select('description, features')
          .eq('vin', vehicleData.VIN_NUMBER)
          .eq('dealer_id', dv.dealer_id)
          .maybeSingle();
        if (cached?.description) {
          aiContent = { description: cached.description, features: (cached.features as [string,string][]) ?? [] };
        } else {
          try {
            const generated = await generateVehicleContent({
              year: vehicleData.YEAR, make: vehicleData.MAKE, model: vehicleData.MODEL,
              trim: vehicleData.TRIM, colorExt: vehicleData.EXT_COLOR,
              mileage: vehicleData.MILEAGE,
              msrp: vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : null,
            }, null);
            aiContent = generated;
            await admin.from('ai_content_cache').upsert({
              vin: vehicleData.VIN_NUMBER, dealer_id: dv.dealer_id,
              description: generated.description, features: generated.features,
              generated_at: new Date().toISOString(), model_version: generated.modelVersion,
            }, { onConflict: 'vin,dealer_id' });
          } catch { /* AI generation failed — tokens render as empty string */ }
        }
      }
      widgets = widgets.map(w => {
        if (w.type !== 'customtext') return w;
        const text = (w.d.text as string) || '';
        if (!text.includes('{{')) return w;
        return { ...w, d: { ...w.d, text: resolveCustomTextTokens(text, vehicleData, options, aiContent) } };
      });
    }

    // ── Render and upload ─────────────────────────────────────────────────────
    const bgUrl = body.bgUrl || savedTemplateBgUrl || customSizeBgUrl || (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
    const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
    const rawLogo = dealer?.logo_url ?? null;
    const dealerLogoUrl = rawLogo
      ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo)
      : null;
    const html = await buildPdfHtml({
      widgets,
      paperSize: effectivePaperSizeStr,
      fontScale: effectiveFontScale,
      bgUrl,
      vehicle: vehicleData,
      options,
      disclaimer: disclaimer ?? undefined,
      dealerLogoUrl,
      customDims: customPaperDims,
    });

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderPdf(html, effectivePaperSizeStr, { customDims: customPaperDims });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "PDF render failed" }, { status: 500 });
    }

    const timestamp = Date.now();
    const s3Key = `${dv.dealer_id}/${dealerVehicleId}/${timestamp}.pdf`;

    let pdfUrl: string;
    try {
      pdfUrl = await uploadPdf(pdfBuffer, s3Key);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "S3 upload failed" }, { status: 500 });
    }

    // ── Print history — source of truth for dashboard stats ──────────────────
    // vehicle_id is stored as the dealer_vehicles UUID string (text column after migration 030)
    // dealer_id matches dealers.dealer_id and profiles.dealer_id
    const { error: phErr } = await admin.from("print_history").insert({
      vehicle_id: dealerVehicleId,
      dealer_id:  dv.dealer_id,
      document_type: docType,
      printed_by: claims.sub,
      pdf_url:    pdfUrl,
    });
    if (phErr) console.error("[pdf/generate] print_history insert failed:", phErr.message, phErr.code, "dealer_id:", dv.dealer_id, "vehicle_id:", dealerVehicleId);

    // ── Audit log ─────────────────────────────────────────────────────────────
    await admin.from("vehicle_audit_log").insert({
      dealer_id: dv.dealer_id,
      vehicle_id: dealerVehicleId,
      stock_number: dv.stock_number,
      action: "print",
      method: "print",
      changed_by: claims.sub,
      document_type: docType,
    } as VehicleAuditLogInsert);

    // ── Write addendum_data — one row per option, permanent compliance record ──
    if (dealer?.id && options.length > 0) {
      const printedAt = new Date().toISOString();
      const adRows: AddendumDataInsert[] = options.map((o, i) => ({
        dealer_id: dealer.id,
        legacy_dealer_id: dv.dealer_id,
        vehicle_id: dealerVehicleId,
        vin_number: dv.vin ?? null,
        item_name: o.option_name,
        item_description: (o as { description?: string | null }).description ?? null,
        item_price: (o as { option_price?: string }).option_price ?? null,
        active: "1",
        or_or_ad: 1,
        order_by: i,
        separator_spaces: 2,
        editable: 1,
        printed_at: printedAt,
        document_type: docType,
      }));
      const { error: adErr } = await admin.from("addendum_data").insert(adRows);
      if (adErr) console.error("[pdf/generate] addendum_data insert failed:", adErr.message, adErr.code);
    }

    // ── Write per-option history rows ─────────────────────────────────────────
    const today = new Date().toISOString().split("T")[0];
    const historyRows: AddendumHistoryInsert[] = options.map((o, i) => ({
      legacy_id:    null,
      vehicle_id:   null,
      vin:          dv.vin ?? null,
      dealer_id:    dv.dealer_id,
      item_name:    "option_name" in o ? o.option_name : (o as { option_name: string }).option_name,
      item_description: null,
      item_price:   "option_price" in o ? (o as { option_price: string }).option_price : null,
      active:       "Yes",
      creation_date: today,
      order_by:     i,
      source:       "platform",
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }));
    if (historyRows.length > 0) {
      await admin.from("addendum_history").insert(historyRows);
    }

    return NextResponse.json({ url: pdfUrl });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[pdf/generate]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
