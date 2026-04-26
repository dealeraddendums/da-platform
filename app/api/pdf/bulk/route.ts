import { NextRequest, NextResponse } from "next/server";
import puppeteer from "puppeteer";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { renderPdf } from "@/lib/pdf-renderer";
import { uploadPdf } from "@/lib/s3-upload";
import { BG_DEFAULT, IS_BG_DEFAULT, LAYOUT, LAYOUT_INFOSHEET, makeWidget } from "@/components/builder/constants";
import { getGroupOptionsForDealer, getGroupDisclaimer } from "@/lib/options-engine";
import { resolveCustomTextTokens } from "@/lib/token-resolver";
import { generateVehicleContent } from "@/lib/ai-content";
import QRCode from "qrcode";
import { PDFDocument } from "pdf-lib";
import type { Widget, PaperSize } from "@/components/builder/types";

// ── Per-vehicle library matching ──────────────────────────────────────────────
// vehicle_id=0 is a shared sentinel for all manual vehicles — using it for bulk
// would apply whichever vehicle last saved its options to all vehicles. Instead,
// we run the addendum_library matching rules per-vehicle inside the loop.

type LibRow = Record<string, unknown>;

function listMatchesLib(val: string | null, field: string | null, notFlag: boolean): boolean {
  if (!field || field.toUpperCase() === "ALL") return true;
  const v = (val ?? "").toLowerCase().trim();
  const items = field.split(",").map(s => s.toLowerCase().trim()).filter(Boolean);
  const found = items.some(item => v === item || v.includes(item));
  return notFlag ? !found : found;
}

function libRowMatchesVehicle(
  r: LibRow,
  condition: string,
  make: string | null,
  model: string | null,
  trim: string | null,
  year: number | null,
  mileage: number | null,
  msrp: number | null,
): boolean {
  // Condition — ad_types (multi-select) takes priority over legacy ad_type
  const adTypes = r.ad_types as string[] | null;
  if (adTypes && adTypes.length > 0) {
    if (!adTypes.includes(condition)) return false;
  } else {
    const adType = (r.ad_type as string) ?? "Both";
    if (adType === "New" && condition !== "New") return false;
    if (adType === "Used" && condition === "New") return false;
  }
  // Makes / Models / Trims
  if (!listMatchesLib(make,  r.makes  as string | null, !!(r.makes_not)))  return false;
  if (!listMatchesLib(model, r.models as string | null, !!(r.models_not))) return false;
  if (!listMatchesLib(trim,  r.trims  as string | null, !!(r.trims_not)))  return false;
  // Year
  const yc = (r.year_condition  as number) ?? 0;
  const yv = (r.year_value      as number | null) ?? null;
  if (yc !== 0 && yv != null && year != null) {
    if (yc === 1 && year !== yv) return false;
    if (yc === 2 && year >   yv) return false;
    if (yc === 3 && year <   yv) return false;
  }
  // Mileage
  const mc = (r.miles_condition as number) ?? 0;
  const mv = (r.miles_value     as number | null) ?? null;
  if (mc !== 0 && mv != null && mileage != null) {
    if (mc === 1 && mileage > mv) return false;
    if (mc === 2 && mileage < mv) return false;
  }
  // MSRP
  const sc = (r.msrp_condition as number) ?? 0;
  const s1 = (r.msrp1          as number | null) ?? null;
  const s2 = (r.msrp2          as number | null) ?? null;
  if (sc !== 0 && msrp != null) {
    if (sc === 1 && s1 != null && msrp > s1) return false;
    if (sc === 2 && s1 != null && msrp < s1) return false;
    if (sc === 3 && s1 != null && s2 != null && (msrp < s1 || msrp > s2)) return false;
  }
  return true;
}

/**
 * POST /api/pdf/bulk
 * Generates PDFs for multiple dealer_vehicles, bundles into a ZIP.
 * Loads each vehicle's saved default template from dealer_settings.
 * vehicleIds are dealer_vehicles UUIDs (Supabase only — no Aurora).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    vehicleIds: string[];
    docType?: "addendum" | "infosheet" | "buyer_guide";
    paperSize?: PaperSize;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vehicleIds, docType = "addendum" } = body;
  if (!vehicleIds?.length) {
    return NextResponse.json({ error: "vehicleIds required" }, { status: 400 });
  }
  if (vehicleIds.length > 50) {
    return NextResponse.json({ error: "Maximum 50 vehicles per bulk request" }, { status: 400 });
  }

  const knownSizes = new Set(["standard", "narrow", "infosheet"]);
  const admin = createAdminSupabaseClient();
  const pdfBuffers: Buffer[] = [];
  const results: { vehicleId: string; pdfUrl?: string; error?: string }[] = [];

  // Cache dealer settings, templates, and option libraries per dealer
  const dealerSettingsCache = new Map<string, DealerSettingsRow | null>();
  const templateCache = new Map<string, Widget[] | null>();
  const templateMetaCache = new Map<string, { bgUrl?: string; fontScale?: number; paperSizeStr?: string }>();
  const libCache = new Map<string, LibRow[]>();

  // Launch one browser for all vehicles — avoids repeated Chrome startup overhead
  const sharedBrowser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
  for (const vehicleId of vehicleIds) {
    try {
      // ── Vehicle ───────────────────────────────────────────────────────────
      const { data: dv } = await admin
        .from("dealer_vehicles")
        .select("*")
        .eq("id", vehicleId)
        .maybeSingle();

      if (!dv) { results.push({ vehicleId, error: "not found" }); continue; }

      if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
        if (dv.dealer_id !== claims.dealer_id) {
          results.push({ vehicleId, error: "forbidden" }); continue;
        }
      }

      // ── Dealer ────────────────────────────────────────────────────────────
      const { data: dealer } = await admin
        .from("dealers")
        .select("dealer_id, name, address, city, state, zip, phone, logo_url")
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle();
      const textDealerId = dealer?.dealer_id ?? "";

      // ── Dealer settings (cached per dealer) ───────────────────────────────
      if (!dealerSettingsCache.has(dv.dealer_id)) {
        const { data: settings } = await admin
          .from("dealer_settings")
          .select([
            "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
            "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
            "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
            "qr_url_template",
          ].join(", "))
          .eq("dealer_id", dv.dealer_id)
          .maybeSingle<DealerSettingsRow>();
        dealerSettingsCache.set(dv.dealer_id, settings ?? null);
      }
      const dealerSettings = dealerSettingsCache.get(dv.dealer_id) ?? null;
      const dealerQrTemplate = (dealerSettings as Record<string, unknown> | null)?.qr_url_template as string | null ?? null;

      // ── Default template for this vehicle's condition + docType ───────────
      let templateWidgets: Widget[] | null = null;
      let templateBgUrl: string | undefined;
      let templateFontScale: number | undefined;
      let templatePaperSizeStr: string | undefined;

      if (dealerSettings) {
        const condKey = dv.condition === "New" ? "new" : dv.condition === "Used" ? "used" : "cpo";
        const docKey = docType === "buyer_guide" ? "buyersguide" : docType;
        const col = `default_${docKey}_${condKey}`;
        const templateId = (dealerSettings as Record<string, unknown>)[col] as string | null;

        if (templateId) {
          if (!templateCache.has(templateId)) {
            const { data: tmpl } = await admin
              .from("templates")
              .select("template_json")
              .eq("id", templateId)
              .maybeSingle<{ template_json: Record<string, unknown> }>();
            if (tmpl?.template_json) {
              const tj = tmpl.template_json as {
                widgets?: Record<string, Widget>;
                bgUrl?: string; fontScale?: number; paperSize?: string;
              };
              templateCache.set(templateId, tj.widgets ? Object.values(tj.widgets) : null);
              templateMetaCache.set(templateId, {
                bgUrl: tj.bgUrl, fontScale: tj.fontScale, paperSizeStr: tj.paperSize,
              });
            } else {
              templateCache.set(templateId, null);
            }
          }
          templateWidgets = templateCache.get(templateId) ?? null;
          const meta = templateMetaCache.get(templateId);
          templateBgUrl = meta?.bgUrl;
          templateFontScale = meta?.fontScale;
          templatePaperSizeStr = meta?.paperSizeStr;
        }
      }

      // ── Effective paper size ──────────────────────────────────────────────
      // Caller body.paperSize overrides template paperSize
      const effectivePaperSizeStr =
        (body.paperSize && knownSizes.has(body.paperSize) ? body.paperSize : null)
        ?? templatePaperSizeStr
        ?? (docType === "infosheet" ? "infosheet" : "standard");
      const isInfosheet = effectivePaperSizeStr === "infosheet";
      const effectivePaperSize = (knownSizes.has(effectivePaperSizeStr) ? effectivePaperSizeStr : "standard") as PaperSize;

      // Custom paper dims
      let customPaperDims: { widthIn: number; heightIn: number } | undefined;
      let customSizeBgUrl: string | undefined;
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

      // ── Options — per-vehicle library matching ────────────────────────────
      // Fetch the dealer's addendum_library once per dealer (cached).
      // Apply matching rules to THIS vehicle so each vehicle gets its own options.
      // (vehicle_id=0 is a shared sentinel updated only when a specific vehicle is
      //  opened in AddendumEditor — unreliable for bulk across multiple vehicles.)
      if (!libCache.has(dv.dealer_id)) {
        const { data: lib } = await admin
          .from("addendum_library")
          .select([
            "option_name", "item_price", "description", "applies_to",
            "ad_types", "ad_type",
            "makes", "makes_not", "models", "models_not", "trims", "trims_not",
            "year_condition", "year_value",
            "miles_condition", "miles_value",
            "msrp_condition", "msrp1", "msrp2",
          ].join(", "))
          .eq("dealer_id", dv.dealer_id)
          .eq("active", true)
          .order("sort_order");
        libCache.set(dv.dealer_id, (lib ?? []) as unknown as LibRow[]);
      }
      const dealerLib = libCache.get(dv.dealer_id)!;

      const vehicleCond = dv.condition === "New" ? "New" : dv.condition === "Used" ? "Used" : "CPO";
      const effectiveOptions = dealerLib
        .filter(r => {
          const appliesTo = (r.applies_to as string) ?? "all";
          if (appliesTo === "none") return false;
          if (appliesTo === "all")  return true;
          return libRowMatchesVehicle(
            r, vehicleCond, dv.make, dv.model, dv.trim,
            dv.year ?? null, dv.mileage ?? null, dv.msrp ?? null,
          );
        })
        .map(r => ({
          option_name: r.option_name as string,
          option_price: (r.item_price as string) ?? "NC",
          description: (r.description as string) || null,
        }));

      const groupOpts = await getGroupOptionsForDealer(textDealerId);
      const options = [
        ...groupOpts.map(g => ({
          option_name: g.option_name, option_price: g.option_price,
          description: null as string | null, active: true as const,
        })),
        ...effectiveOptions,
      ];

      const disclaimer = await getGroupDisclaimer(textDealerId, dealer?.state ?? null, docType);

      // ── Vehicle data shape ────────────────────────────────────────────────
      const vehicleData = {
        id: 0 as const,
        DEALER_ID: dv.dealer_id,
        VIN_NUMBER: dv.vin ?? "",
        STOCK_NUMBER: dv.stock_number,
        YEAR: dv.year ? String(dv.year) : null,
        MAKE: dv.make, MODEL: dv.model, TRIM: dv.trim,
        BODYSTYLE: dv.body_style, EXT_COLOR: dv.exterior_color,
        INT_COLOR: dv.interior_color, ENGINE: dv.engine, FUEL: null,
        DRIVETRAIN: dv.drivetrain, TRANSMISSION: dv.transmission,
        MILEAGE: dv.mileage ? String(dv.mileage) : null,
        DATE_IN_STOCK: dv.date_added, STATUS: "1" as const,
        MSRP: dv.msrp ? String(dv.msrp) : null,
        NEW_USED: dv.condition === "Used" ? "Used" : "New",
        CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
        OPTIONS: null, PHOTOS: null, DESCRIPTION: dv.description ?? null,
        PRINT_STATUS: "0" as const, HMPG: null, CMPG: null, MPG: null,
      };

      // ── Build widget layout ───────────────────────────────────────────────
      let widgets: Widget[];
      if (templateWidgets && templateWidgets.length > 0) {
        widgets = templateWidgets;
      } else {
        const layout = isInfosheet ? LAYOUT_INFOSHEET : LAYOUT;
        const order = isInfosheet
          ? ["logo", "vehicle", "description", "features", "askbar", "qrcode", "barcode", "dealer", "customtext"]
          : ["logo", "vehicle", "msrp", "options", "subtotal", "askbar", "dealer", "infobox"];
        let nid = 1;
        widgets = order.filter(t => layout[t]).map(t => {
          const id = "w" + nid++;
          const w = makeWidget(t, id, undefined, undefined, undefined, undefined, isInfosheet);
          if (t === "msrp" && vehicleData.MSRP) {
            const msrp = parseFloat(vehicleData.MSRP);
            if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
          }
          if (t === "dealer") {
            const lines = [
              dealer?.name, dealer?.address,
              [dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(" "),
              dealer?.phone,
            ].filter(Boolean);
            if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
          }
          if (t === "logo" && dealer?.logo_url) w.d = { ...w.d, imgUrl: dealer.logo_url };
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

      // ── QR code generation ────────────────────────────────────────────────
      const qrWidgets = widgets.filter(w => w.type === "infobox" && (w.d.ibType as string) === "qr");
      if (qrWidgets.length > 0) {
        widgets = await Promise.all(widgets.map(async w => {
          if (w.type !== "infobox" || (w.d.ibType as string) !== "qr") return w;
          const vin = dv.vin ?? "";
          const stock = dv.stock_number ?? "";
          const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
          const qrUrl = dv.vdp_link ?? (tmplStr
            ? tmplStr.replace("[VIN]", vin).replace("[STOCK]", stock)
            : null);
          if (!qrUrl) return w;
          try {
            const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, color: { dark: "#000000", light: "#ffffff" } });
            return { ...w, d: { ...w.d, imgUrl: dataUrl } };
          } catch { return w; }
        }));
      }

      // ── Token resolution ──────────────────────────────────────────────────
      const tokenWidgets = widgets.filter(
        w => w.type === "customtext" && ((w.d.text as string) || "").includes("{{")
      );
      if (tokenWidgets.length > 0) {
        let aiContent: { description: string; features: [string, string][] } | null = null;
        const needsAi = tokenWidgets.some(w => ((w.d.text as string) || "").includes("{{ai."));
        if (needsAi && vehicleData.VIN_NUMBER) {
          const { data: cached } = await admin
            .from("ai_content_cache")
            .select("description, features")
            .eq("vin", vehicleData.VIN_NUMBER)
            .eq("dealer_id", dv.dealer_id)
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
              await admin.from("ai_content_cache").upsert({
                vin: vehicleData.VIN_NUMBER, dealer_id: dv.dealer_id,
                description: generated.description, features: generated.features,
                generated_at: new Date().toISOString(), model_version: generated.modelVersion,
              }, { onConflict: "vin,dealer_id" });
            } catch { /* AI generation failed — tokens render empty */ }
          }
        }
        widgets = widgets.map(w => {
          if (w.type !== "customtext") return w;
          const text = (w.d.text as string) || "";
          if (!text.includes("{{")) return w;
          return { ...w, d: { ...w.d, text: resolveCustomTextTokens(text, vehicleData, options, aiContent) } };
        });
      }

      // ── Render ────────────────────────────────────────────────────────────
      const bgUrl = templateBgUrl ?? customSizeBgUrl ?? (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
      const fontScale = templateFontScale ?? 1.0;
      const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
      const rawLogo = dealer?.logo_url ?? null;
      const dealerLogoUrl = rawLogo
        ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo) : null;

      const html = await buildPdfHtml({
        widgets, paperSize: effectivePaperSizeStr, fontScale, bgUrl,
        vehicle: vehicleData, options,
        disclaimer: disclaimer ?? undefined,
        dealerLogoUrl, customDims: customPaperDims,
      });
      const pdfBuffer = await renderPdf(html, effectivePaperSizeStr, { customDims: customPaperDims, browser: sharedBrowser });

      const timestamp = Date.now();
      const s3Key = `${dv.dealer_id}/${vehicleId}/${timestamp}.pdf`;
      const pdfUrl = await uploadPdf(pdfBuffer, s3Key);

      await admin.from("print_history").insert({
        vehicle_id: vehicleId, dealer_id: dv.dealer_id,
        document_type: docType, printed_by: claims.sub, pdf_url: pdfUrl,
      });

      pdfBuffers.push(pdfBuffer);
      results.push({ vehicleId, pdfUrl });
    } catch (err) {
      results.push({ vehicleId, error: err instanceof Error ? err.message : "error" });
    }
  }
  } finally {
    await sharedBrowser.close();
  }

  const succeeded = results.filter(r => !r.error);
  if (!succeeded.length) {
    return NextResponse.json({ error: "All vehicles failed", results }, { status: 500 });
  }

  if (pdfBuffers.length === 1) {
    return NextResponse.json({ url: succeeded[0].pdfUrl, results });
  }

  // Merge all PDFs into one document
  const merged = await PDFDocument.create();
  for (const buf of pdfBuffers) {
    const src = await PDFDocument.load(buf);
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }
  const mergedBuffer = Buffer.from(await merged.save());
  const mergedKey = `bulk/${claims.sub}/${docType}_${Date.now()}.pdf`;
  const mergedUrl = await uploadPdf(mergedBuffer, mergedKey);

  return NextResponse.json({ url: mergedUrl, results });
}
