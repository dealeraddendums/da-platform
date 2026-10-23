import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { resolveQrUrlTemplate } from "@/lib/qr-url";
import { isRestylerGroup } from "@/lib/restyler";
import { buildPdfKey } from "@/lib/s3-upload";
import { useService as usePdfService, renderViaService, renderBulkViaService, enqueueGenerate, enqueueMerged, type PdfDocTypeTag } from "@/lib/pdf-service-client";
import { enforceCanPrint } from "@/lib/print-eligibility";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { createPendingPrint, recordPrint, type PrintRecordPayload } from "@/lib/record-print";

type BgOption = { option_name: string; option_price?: string; description?: string | null; required?: boolean };

import {
  BG_DEFAULT,
  IS_BG_DEFAULT,
  LAYOUT,
  LAYOUT_INFOSHEET,
  makeWidget,
} from "@/components/builder/constants";
import { getGroupDisclaimers } from "@/lib/options-engine";
import { resolveVehiclePrintOptions } from "@/lib/print-options";
import { resolveTemplate, resolveSecondAddendum, SECOND_ADDENDUM_SETTINGS_COLUMNS, type ResolvedTemplate } from "@/lib/template-resolver";
import { resolveCustomTextTokens } from "@/lib/token-resolver";
import { aiConditionLabel, effectiveDescriptionModifiers, scrubVehicleDescription } from "@/lib/vehicle-description-ai";
import { generateVehicleContent, enforceDbMileage } from "@/lib/ai-content";
import QRCode from "qrcode";
import type { Widget, PaperSize } from "@/components/builder/types";
import { vehicleConditionFields, resolveVehicleCondition } from "@/lib/vehicles";

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
    /** Retail/Wholesale 'ask' price from the Print Now prompt (render-only). */
    retailWholesalePrice?: number;
    /** True = resolve the effective template and return { askRetailWholesale }
     *  WITHOUT rendering — PrintPreviewModal probes this to know whether to
     *  prompt for a price. Reuses the exact template-resolution path so the
     *  prompt can't drift from what actually renders. */
    checkPromptOnly?: boolean;
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

    // dealer roles → own; group_admin → in-group (dealer they're switched into);
    // super_admin → any. Previously group_admin fell through with no group check.
    const authz = await authorizeDealerAction(claims, dv.dealer_id as string);
    if (!authz.ok) return authz.response;

    // Print-eligibility gate (super_admin bypasses).
    const blocked = await enforceCanPrint(dv.dealer_id, claims);
    if (blocked) return blocked;

    // ── Dealer from Supabase ──────────────────────────────────────────────────
    // dealer_vehicles.dealer_id is the TEXT dealer_id (matches dealers.dealer_id, not dealers.id UUID)
    const { data: dealer } = await admin
      .from("dealers")
      .select("id, dealer_id, internal_id, name, address, city, state, zip, phone, logo_url, group_id")
      .eq("dealer_id", dv.dealer_id)
      .maybeSingle();

    // Restyler account (migration 149): every print from a restyler group's
    // stores carries the locked attribution footer — forced at render time,
    // never a template widget.
    const restylerAttribution = await isRestylerGroup(admin, (dealer as { group_id?: string | null } | null)?.group_id ?? null);

    // dealer.dealer_id is the text ID used by group options / disclaimers
    const textDealerId = dealer?.dealer_id ?? "";

    // ── Dealer QR URL template + price-display preference ────────────────────
    // Read from the PRINTING dealer's settings (dv.dealer_id) so group
    // templates honor each member dealer's own choices, like logo injection.
    let dealerQrTemplate: string | null = null;
    let alwaysShowCents = false;
    let appendElectrificationToTrim = false;
    try {
      const { data: dealerQrSettings } = await admin
        .from("dealer_settings")
        .select("qr_url_template, always_show_cents, append_electrification_to_trim")
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle<{ qr_url_template: string | null; always_show_cents: boolean | null; append_electrification_to_trim: boolean | null }>();
      dealerQrTemplate = dealerQrSettings?.qr_url_template ?? null;
      alwaysShowCents = dealerQrSettings?.always_show_cents === true;
      appendElectrificationToTrim = dealerQrSettings?.append_electrification_to_trim === true;
    } catch { /* columns may not exist until migrations 034/144 are applied */ }

    // Products for this vehicle — lib/print-options.ts (shared with the Builder's "As vehicle" preview).
    const { vehicleData, options, saveOptions } = await resolveVehiclePrintOptions(admin, dv, dealerVehicleId, textDealerId);
    const disclaimers = await getGroupDisclaimers(textDealerId, dealer?.state ?? null, docType);

    // ── Load dealer's saved default template from dealer_settings ────────────
    // Only runs when no widgets were supplied by the caller (i.e. Print Now,
    // not a Builder print which passes its own widget layout).
    let savedTemplateWidgets: Widget[] | null = null;
    let savedTemplateIsGroup = false;
    let savedTemplateBgUrl: string | undefined;
    let savedRestylerAttrPos: { x?: unknown; y?: unknown } | null = null;
    let savedTemplateFontScale: number | undefined;
    let savedTemplatePaperSize: PaperSize | undefined;
    // Double addendum (migration 162): the OPTIONAL second template for this
    // vehicle's condition. null on every path except an addendum print by a
    // dealer who has the feature on AND a second template set for the
    // condition — so every other print is byte-for-byte what it was before.
    let secondTemplate: ResolvedTemplate | null = null;
    let aiEnabled = true; // default: AI mode per platform default

    if (!inWidgets || inWidgets.length === 0) {
      const { data: settings } = await admin
        .from("dealer_settings")
        .select([
          "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
          "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
          "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
          "ai_content_default",
          // Double-addendum (migration 162) — the second template ids + the toggle.
          ...SECOND_ADDENDUM_SETTINGS_COLUMNS,
        ].join(", "))
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle<DealerSettingsRow>();

      if (settings) aiEnabled = settings.ai_content_default ?? true;

      // Template selection lives in lib/template-resolver.ts — ONE implementation
      // shared with pdf/bulk, so Print Now, the print screen, bulk print and both
      // mobile print paths can never brand a vehicle differently.
      const resolved = await resolveTemplate(admin, {
        dealerTextId: dv.dealer_id,
        docType,
        condition: resolveVehicleCondition(dv),
        make: dv.make,
        mileage: dv.mileage,
        settings: settings as Record<string, unknown> | null,
      });
      savedTemplateWidgets = resolved.widgets;
      savedTemplateIsGroup = resolved.isGroup;
      savedRestylerAttrPos = resolved.restylerAttrPos;
      if (resolved.bgUrl) savedTemplateBgUrl = resolved.bgUrl;
      if (typeof resolved.fontScale === "number") savedTemplateFontScale = resolved.fontScale;
      if (resolved.paperSizeStr) savedTemplatePaperSize = resolved.paperSizeStr as PaperSize;
      console.log(`[pdf/generate] template source=${resolved.source}${resolved.makeKey ? ` make=${resolved.makeKey}` : ""} id=${resolved.templateId ?? "none"} group=${resolved.isGroup}`);

      // The second addendum rides on the SAME settings row and the SAME
      // resolved condition as the primary, so the two can never disagree about
      // which vehicle condition is in play. Addendums only — an infosheet or
      // buyer's guide never gets a second document.
      if (docType === "addendum") {
        secondTemplate = await resolveSecondAddendum(admin, {
          condition: resolveVehicleCondition(dv),
          settings: settings as Record<string, unknown> | null,
        });
        if (secondTemplate) {
          console.log(`[pdf/generate] double addendum — second template id=${secondTemplate.templateId} group=${secondTemplate.isGroup}`);
        }
      }
    }

    // ── Resolve custom paper size dimensions ──────────────────────────────────
    // Extracted so the optional SECOND addendum resolves its own paper size the
    // same way the primary does — a second template saved at a custom size has
    // to render at that size, not inherit the primary's.
    const knownSizes = new Set(['standard', 'narrow', 'infosheet']);
    interface CustomSizeInfo {
      dims?: { widthIn: number; heightIn: number };
      bgUrl?: string;
      docType?: 'addendum' | 'infosheet';
    }
    const customSizeDealerId = dv.dealer_id;
    const resolveCustomSize = async (sizeStr: string): Promise<CustomSizeInfo> => {
      if (knownSizes.has(sizeStr)) return {};
      const { data: cs } = await admin
        .from("dealer_custom_sizes")
        .select("width_in, height_in, background_url, doc_type")
        .eq("id", sizeStr)
        .eq("dealer_id", customSizeDealerId)
        .maybeSingle();
      if (!cs) return {};
      return {
        dims: { widthIn: Number(cs.width_in), heightIn: Number(cs.height_in) },
        ...(cs.background_url ? { bgUrl: cs.background_url as string } : {}),
        ...(cs.doc_type === 'infosheet' || cs.doc_type === 'addendum' ? { docType: cs.doc_type as 'addendum' | 'infosheet' } : {}),
      };
    };

    const effectivePaperSizeStr = savedTemplatePaperSize ?? paperSize;
    const primaryCustom = await resolveCustomSize(effectivePaperSizeStr);
    const customPaperDims = primaryCustom.dims;
    const customSizeBgUrl = primaryCustom.bgUrl;
    const customSizeDocType = primaryCustom.docType;

    // ── Build widget layout ───────────────────────────────────────────────────
    const effectivePaperSize: PaperSize = (knownSizes.has(effectivePaperSizeStr) ? effectivePaperSizeStr : 'standard') as PaperSize;
    const effectiveFontScale = savedTemplateFontScale ?? fontScale;
    // A custom size with doc_type='infosheet' should render as an infosheet
    // even though effectivePaperSize falls back to 'standard' for the layout
    // tables. Without this branch the AI description/features fetch and the
    // infosheet background bucket selection both miss for custom infosheets.
    const isInfosheet = effectivePaperSize === "infosheet" || customSizeDocType === "infosheet";
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
          // This layout is CODE-GENERATED, not authored — the dealer has no
          // template, so nobody chose a content source for it. makeWidget
          // defaults aiMode to 'db' (the Builder's display default), and since
          // b98eff6 a 'db' widget renders database content or an empty section,
          // never AI. For a dealer who has never built an infosheet that meant
          // the account-level AI setting appeared to do nothing and the sheet
          // printed blank whenever the feed carried no description/options
          // (Envision Ford of Oxnard, 2026-09-10).
          //
          // b98eff6 exists to respect a HUMAN's explicit DB choice; a
          // placeholder widget expresses no choice at all, so seed it from the
          // dealer's own default instead. Authored templates keep the
          // per-widget toggle as the sole authority — unchanged.
          if (t === "description" || t === "features") {
            w.d = { ...w.d, aiMode: aiEnabled ? "ai" : "db" };
          }
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

    // ── Normalize dealer-specific widget data ─────────────────────────────
    // Saved templates (especially group templates shared across dealers) carry
    // whatever logo URL and dealer text were on the canvas at save time. The
    // dealer-address widget always reflects the current dealer's address.
    // Logo widgets fall back to dealer.logo_url ONLY when the saved widget
    // doesn't already point at a specific image chosen from the "Choose Logo
    // Image" library — a picked image must survive print, otherwise the
    // template stops matching what the canvas shows.
    const dealerLogoForWidget = dealer?.logo_url ?? null;
    const dealerLines = [
      dealer?.name,
      dealer?.address,
      [dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(" ").trim() || null,
      dealer?.phone,
    ].filter(Boolean) as string[];
    widgets = widgets.map(w => {
      if (w.type === "logo") {
        const existing = typeof w.d.imgUrl === "string" ? w.d.imgUrl : "";
        if (existing) return w;
        return { ...w, d: { ...w.d, imgUrl: dealerLogoForWidget } };
      }
      if (w.type === "dealer" && dealerLines.length > 0) {
        return { ...w, d: { ...w.d, text: dealerLines.join("\n") } };
      }
      return w;
    });

    // ── Generate QR codes for infobox-qr and qrcode widgets ─────────────────
    const hasQrWidgets = widgets.some(
      w => (w.type === 'infobox' && (w.d.ibType as string) === 'qr') || w.type === 'qrcode'
    );
    if (hasQrWidgets) {
      widgets = await Promise.all(widgets.map(async w => {

        if (w.type === 'infobox' && (w.d.ibType as string) === 'qr') {
          const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
          const qrUrl = dv.vdp_link ?? resolveQrUrlTemplate(tmplStr, dv);
          if (!qrUrl) return w;
          try {
            const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
            return { ...w, d: { ...w.d, imgUrl: dataUrl } };
          } catch { return w; }
        }

        if (w.type === 'qrcode') {
          // Pre-generate QR as server-side data URL — eliminates external api.qrserver.com dependency
          const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
          const resolvedTmpl = resolveQrUrlTemplate(tmplStr, dv);
          const baseUrl = dv.vdp_link ?? resolvedTmpl ?? (w.d.url as string) ?? 'https://dealeraddendums.com';
          try {
            const dataUrl = await QRCode.toDataURL(baseUrl, { width: 300, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
            return { ...w, d: { ...w.d, imgUrl: dataUrl } };
          } catch { return w; }
        }

        return w;
      }));
    }

    // ── Resolve ChromeData vehicle photo URLs for any vehiclephoto widgets ──
    // (and legacy infobox-photo widgets that haven't been converted yet)
    const needsVehiclePhoto = widgets.some(
      w => w.type === 'vehiclephoto' || (w.type === 'infobox' && (w.d.ibType as string) === 'photo'),
    );
    if (needsVehiclePhoto) {
      const { VEHICLE_PHOTO_COMING_SOON } = await import('@/components/builder/constants');
      let resolvedUrl: string | null = null;
      if (dv.vin) {
        try {
          const { resolveChromeVehicleImage } = await import('@/lib/chromedata');
          const photo = await resolveChromeVehicleImage(dv.vin, dv.exterior_color ?? '');
          resolvedUrl = photo.image_url;
          console.log(`[pdf/generate] vehicle photo: vin=${dv.vin} color=${dv.exterior_color ?? ''} → ${resolvedUrl ? 'hit' : 'miss'} (${photo.source})`);
        } catch (err) {
          console.error('[pdf/generate] vehicle photo resolve failed:', err instanceof Error ? err.message : err);
        }
      } else {
        console.log('[pdf/generate] vehicle photo: vehicle has no VIN — using Coming Soon fallback');
      }
      // Always set imgUrl so the renderer never shows the canvas placeholder
      // text in a printed PDF. Coming Soon stands in when ChromeData has nothing.
      const finalUrl = resolvedUrl ?? VEHICLE_PHOTO_COMING_SOON;
      widgets = widgets.map(w => {
        if (w.type === 'vehiclephoto' || (w.type === 'infobox' && (w.d.ibType as string) === 'photo')) {
          return { ...w, d: { ...w.d, imgUrl: finalUrl } };
        }
        return w;
      });
    }

    // ── Resolve auto-mode watermark URL from the vehicle make ──────────────────
    // mode='auto' watermarks resolve their brand image at print time from the
    // vehicle's make. We ALWAYS set d.imgUrl (to a resolved URL, or '' when the
    // make has no matching brand file) so the renderer never prints the canvas
    // "Auto watermark" placeholder. fixed-mode watermarks render from d.brand in
    // the renderer and need no injection here.
    if (widgets.some(w => w.type === 'watermark' && (w.d.mode as string) === 'auto')) {
      const { resolveBrandForMake, watermarkUrl } = await import('@/lib/watermarks');
      const brand = resolveBrandForMake(vehicleData.MAKE);
      const autoUrl = brand ? watermarkUrl(brand) : '';
      widgets = widgets.map(w =>
        (w.type === 'watermark' && (w.d.mode as string) === 'auto')
          ? { ...w, d: { ...w.d, imgUrl: autoUrl } }
          : w
      );
    }

    // ── Fetch AI content for infosheet description/features + {{ai.}} tokens ───
    // Fetched when an AI-set widget or an {{ai.}} token needs it; DB-set
    // widgets render database data only (see pdf-html.ts) and skip the call.
    let aiContent: { description: string; features: [string, string][] } | null = null;
    // Only when a description/features widget is actually SET to AI — the
    // per-widget toggle is authoritative (pdf-html honors it), so a sheet
    // whose widgets are all DB never needs (or pays for) an AI call.
    const needsAiForInfosheet = isInfosheet && widgets.some(
      w => (w.type === 'description' || w.type === 'features') && w.d?.aiMode === 'ai'
    );
    const hasAiTokens = widgets.some(
      w => w.type === 'customtext' && ((w.d.text as string) || '').includes('{{ai.')
    );
    if ((needsAiForInfosheet || hasAiTokens) && vehicleData.VIN_NUMBER) {
      const { data: cachedAi } = await admin
        .from('ai_content_cache')
        .select('description, features')
        .eq('vin', vehicleData.VIN_NUMBER)
        .eq('dealer_id', dv.dealer_id)
        .maybeSingle();
      if (cachedAi?.description) {
        aiContent = { description: cachedAi.description, features: (cachedAi.features as [string,string][]) ?? [] };
      } else {
        try {
          const generated = await generateVehicleContent({
            year: vehicleData.YEAR, make: vehicleData.MAKE, model: vehicleData.MODEL,
            trim: vehicleData.TRIM, colorExt: vehicleData.EXT_COLOR,
            mileage: vehicleData.MILEAGE,
            // Conditional house rules ("…for all used vehicles") need it.
            condition: aiConditionLabel(dv),
            msrp: vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : null,
          }, null, (await effectiveDescriptionModifiers(admin, dv.dealer_id as string)).lines);
          aiContent = generated;
          await admin.from('ai_content_cache').upsert({
            vin: vehicleData.VIN_NUMBER, dealer_id: dv.dealer_id,
            description: generated.description, features: generated.features,
            generated_at: new Date().toISOString(), model_version: generated.modelVersion,
          }, { onConflict: 'vin,dealer_id' });
        } catch (err) {
          console.error('[pdf/generate] AI generation failed:', err instanceof Error ? err.message : err);
        }
      }
    }
    // Mileage is a fact — override/drop the AI table's mileage row with the
    // real DB value (also corrects stale ai_content_cache rows; see
    // enforceDbMileage). Applied before BOTH consumers: the features widget
    // and the {{ai.features}} custom-text token.
    if (aiContent) aiContent = { ...aiContent, features: enforceDbMileage(aiContent.features, dv.mileage as number | null) };
    // Facts-only read-time net: cached descriptions (some written before the
    // guard) never print a warranty/condition/history claim.
    if (aiContent?.description) aiContent = { ...aiContent, description: scrubVehicleDescription(aiContent.description, dv as Record<string, unknown>, (await effectiveDescriptionModifiers(admin, dv.dealer_id as string)).lines) };
    // The dealer's saved per-vehicle description (migration 173) wins for the
    // description widget (pdf-html) AND the {{ai.description}} token.
    const savedDescription = String((dv as Record<string, unknown>).infosheet_ai_description ?? "").trim() || null;
    const tokenAiContent = savedDescription ? { description: savedDescription, features: aiContent?.features ?? [] } : aiContent;

    console.log('[pdf/generate] aiEnabled:', aiEnabled, 'aiContent:', aiContent ? 'yes' : 'none', 'dbDescription:', vehicleData.DESCRIPTION ? 'yes' : 'null', 'dbOptions:', (dv as Record<string, unknown>).options ? 'yes' : 'null');

    // ── Apply {{token}} patterns in customtext widgets ─────────────────────────
    if (widgets.some(w => w.type === 'customtext' && ((w.d.text as string) || '').includes('{{'))) {
      widgets = widgets.map(w => {
        if (w.type !== 'customtext') return w;
        const text = (w.d.text as string) || '';
        if (!text.includes('{{')) return w;
        return { ...w, d: { ...w.d, text: resolveCustomTextTokens(text, vehicleData, options, tokenAiContent) } };
      });
    }

    // ── Render and upload ─────────────────────────────────────────────────────
    // Prompt probe: PrintPreviewModal asks whether the EFFECTIVE template has
    // a Retail/Wholesale widget in 'ask' mode before rendering, so it knows
    // to collect a price. Runs the identical resolution path above and exits
    // before any rendering work.
    if (body.checkPromptOnly) {
      const askRetailWholesale = widgets.some(
        (w) => w.type === "retail_wholesale" && ((w.d as Record<string, unknown> | undefined)?.mode ?? "percent") === "ask",
      );
      return NextResponse.json({ askRetailWholesale });
    }

    const bgUrl = body.bgUrl || savedTemplateBgUrl || customSizeBgUrl || (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
    const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
    const rawLogo = dealer?.logo_url ?? null;
    const dealerLogoUrl = rawLogo
      ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo)
      : null;
    // Everything that describes THE VEHICLE rather than the template. Shared
    // verbatim by the primary and the optional second addendum so the two
    // documents can never disagree about products, pricing or AI content —
    // only the layout (widgets/paper/background/scale) differs between them.
    const sharedHtmlArgs = {
      retailWholesalePrice: typeof body.retailWholesalePrice === "number" && Number.isFinite(body.retailWholesalePrice) && body.retailWholesalePrice > 0 ? body.retailWholesalePrice : null,
      vehicle: vehicleData,
      options,
      disclaimers,
      dealerLogoUrl,
      dealer: dealer ? { name: dealer.name, address: dealer.address, city: dealer.city, state: dealer.state, zip: dealer.zip, phone: dealer.phone } : undefined,
      aiEnabled,
      aiDescription: aiContent?.description ?? null,
      aiFeatures: (aiContent?.features as [string, string][] | undefined) ?? null,
      dbDescription: vehicleData.DESCRIPTION ?? null,
      savedDescription,
      dbOptionsText: (dv as Record<string, unknown>).options as string | null ?? null,
      alwaysShowCents,
      appendElectrificationToTrim,
      restylerAttribution,
    };

    const html = await buildPdfHtml({
      ...sharedHtmlArgs,
      widgets,
      paperSize: effectivePaperSizeStr,
      fontScale: effectiveFontScale,
      bgUrl,
      forceDealerLogo: savedTemplateIsGroup,
      customDims: customPaperDims,
      // Builder "Download PDF" sends live ad-hoc widgets + the current canvas
      // position; a saved-template print reads it from the template JSON. The
      // clamp in resolveRestylerAttrPos sanitizes either source.
      restylerAttrPos: (body as { restylerAttrPos?: { x?: unknown; y?: unknown } | null }).restylerAttrPos ?? savedRestylerAttrPos,
    });

    // ── Second addendum (migration 162) ──────────────────────────────────────
    // Rendered with ITS OWN template metadata — paper size, custom dimensions,
    // background and font scale all come from the second template, exactly as
    // the primary takes them from its own. The dealer-level printer nudge is
    // applied downstream in buildPdfHtml for both, so both sheets land on the
    // paper the same way.
    let secondHtml: string | null = null;
    let secondPaperSizeStr: string | undefined;
    let secondCustomDims: { widthIn: number; heightIn: number } | undefined;
    if (secondTemplate && secondTemplate.widgets && secondTemplate.widgets.length > 0) {
      secondPaperSizeStr = (secondTemplate.paperSizeStr as PaperSize | undefined) ?? paperSize;
      const secondCustom = await resolveCustomSize(secondPaperSizeStr);
      secondCustomDims = secondCustom.dims;
      secondHtml = await buildPdfHtml({
        ...sharedHtmlArgs,
        widgets: secondTemplate.widgets,
        paperSize: secondPaperSizeStr,
        fontScale: typeof secondTemplate.fontScale === "number" ? secondTemplate.fontScale : fontScale,
        bgUrl: secondTemplate.bgUrl || secondCustom.bgUrl || BG_DEFAULT,
        forceDealerLogo: secondTemplate.isGroup,
        customDims: secondCustomDims,
        restylerAttrPos: secondTemplate.restylerAttrPos,
      });
    }

    const s3Key = buildPdfKey({
      internalId: dealer?.internal_id ?? null,
      dealerIdFallback: dv.dealer_id,
      vehicleUuid: dealerVehicleId,
      vin: dv.vin,
      docType,
    });

    // Print recording is DEFERRED to the user's actual Send-to-Printer /
    // Download click: we stash the full logging payload in pending_prints and
    // hand the client a one-time token; POST /api/print/confirm replays it via
    // lib/record-print.ts. A preview that's cancelled never records a print
    // (multiprint-qa-2026-06-11, secondary item). If the stash fails (e.g.
    // migration 099 not applied), fall back to the legacy generation-time
    // logging so prints are never silently lost. Note: the Builder's template
    // test-download hits this route too and never confirms — by design
    // (the Builder never prints).
    const printPayload: PrintRecordPayload = {
      source: "generate",
      vehicleId: dealerVehicleId,
      dealerTextId: dv.dealer_id,
      dealerUuid: dealer?.id ?? null,
      vin: dv.vin,
      stockNumber: dv.stock_number,
      docType,
      s3Key,
      options,
      saveOptions,
    };

    // Phase E: async mode. Browser sends ?async=1 to get a jobId back
    // immediately, then polls /api/pdf/status/:jobId for completion.
    // Only meaningful when the service path is on — the local Puppeteer
    // path doesn't know about jobs, so it falls through to the sync
    // bytes response below.
    const asyncMode = req.nextUrl.searchParams.get("async") === "1";
    if (asyncMode && usePdfService()) {
      try {
        // Double addendum: one merge job (primary first) instead of one
        // single-render job. Same jobId contract, same status endpoint, same
        // s3Key — so the browser's existing polling is untouched.
        const { jobId } = secondHtml
          ? await enqueueMerged(
              [
                { html, paperSize: effectivePaperSizeStr, customDims: customPaperDims },
                { html: secondHtml, paperSize: secondPaperSizeStr, customDims: secondCustomDims },
              ],
              s3Key,
              docType as PdfDocTypeTag,
            )
          : await enqueueGenerate(html, {
              paperSize: effectivePaperSizeStr,
              customDims: customPaperDims,
              docType: docType as PdfDocTypeTag,
            }, s3Key);
        const printToken = await createPendingPrint(admin, { dealerTextId: dv.dealer_id, createdBy: claims.sub, payloads: [printPayload] });
        if (!printToken) {
          void recordPrint(admin, claims.sub, printPayload)
            .catch(err => console.error("[pdf/generate] fallback logging error:", err instanceof Error ? err.message : err));
        }
        return NextResponse.json({
          jobId,
          statusUrl: `/api/pdf/status/${jobId}`,
          s3Key,
          printToken,
        });
      } catch (err) {
        return NextResponse.json({ error: err instanceof Error ? err.message : "PDF enqueue failed" }, { status: 500 });
      }
    }

    // Phase 10b: PDF service is the only render path. Local Puppeteer
    // was removed in Phase E.2 (commit notes for context). If the
    // service env isn't configured, error rather than render something
    // half-baked.
    if (!usePdfService()) {
      return NextResponse.json({ error: "PDF service not configured (PDF_SERVICE_URL + PDF_SERVICE_API_KEY required)" }, { status: 503 });
    }
    let pdfBuffer: Buffer;
    try {
      // The service uploads to s3Key itself with the doc_type tag.
      // Double addendum goes through the bulk endpoint, which renders both
      // documents and merges them in order — the merged PDF is what lands at
      // s3Key ({VIN}.pdf), so the dealer-website Download button serves the
      // whole sticker set, not just page one.
      if (secondHtml) {
        const merged = await renderBulkViaService(
          [
            { html, paperSize: effectivePaperSizeStr, customDims: customPaperDims },
            { html: secondHtml, paperSize: secondPaperSizeStr, customDims: secondCustomDims },
          ],
          s3Key,
          docType as PdfDocTypeTag,
        );
        pdfBuffer = merged.buffer;
      } else {
        const result = await renderViaService(html, {
          paperSize: effectivePaperSizeStr,
          customDims: customPaperDims,
          docType: docType as PdfDocTypeTag,
        }, s3Key);
        pdfBuffer = result.buffer;
      }
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "PDF render failed" }, { status: 500 });
    }

    // Bytes response — print token travels in a header. Callers that never
    // confirm (the Builder's test download) simply leave the pending row to GC.
    const syncToken = await createPendingPrint(admin, { dealerTextId: dv.dealer_id, createdBy: claims.sub, payloads: [printPayload] });
    if (!syncToken) {
      void recordPrint(admin, claims.sub, printPayload)
        .catch(err => console.error("[pdf/generate] fallback logging error:", err instanceof Error ? err.message : err));
    }

    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfBuffer.length),
        ...(syncToken ? { "X-Print-Token": syncToken } : {}),
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[pdf/generate]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
