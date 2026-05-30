import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert, AddendumHistoryInsert, AddendumDataInsert, DealerSettingsRow } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { uploadPdf, buildPdfKey } from "@/lib/s3-upload";
import { useService as usePdfService, renderViaService, enqueueGenerate, awaitJobAndFetch } from "@/lib/pdf-service-client";
import { syncAddendumItems } from "@/lib/sync-addendum-items";

type BgOption = { option_name: string; option_price?: string; description?: string | null; required?: boolean };

async function logGeneratePdf(
  pdfBuffer: Buffer,
  s3Key: string,
  dealerVehicleId: string,
  dv: { dealer_id: string; vin: string | null; stock_number: string | null },
  dealer: { id: string; dealer_id: string } | null,
  claims: { sub: string },
  docType: "addendum" | "infosheet" | "buyer_guide",
  options: BgOption[],
  admin: ReturnType<typeof createAdminSupabaseClient>,
): Promise<void> {
  let pdfUrl = "";
  let uploadedKey: string | null = null;
  try {
    pdfUrl = await uploadPdf(pdfBuffer, s3Key);
    uploadedKey = s3Key;
  } catch (err) {
    console.error("[pdf/generate] S3 upload failed:", err instanceof Error ? err.message : err);
  }

  const { error: phErr } = await admin.from("print_history").insert({
    vehicle_id: dealerVehicleId,
    dealer_id: dv.dealer_id,
    document_type: docType,
    printed_by: claims.sub,
    pdf_url: pdfUrl || null,
  });
  if (phErr) console.error("[pdf/generate] print_history insert failed:", phErr.message, phErr.code);

  // Mark the canonical print fields on dealer_vehicles so dashboard counts,
  // legacy-aware filters, and the per-document button states see this vehicle
  // as printed without depending on print_history. The doc type controls
  // which column flips: addendum → print_status, infosheet → print_info,
  // buyer_guide → print_guide.
  const todayDate = new Date().toISOString().split("T")[0];
  const dvUpdate: Partial<{ print_status: number; print_info: number; print_guide: number; print_date: string; print_user: string }> = {
    print_date: todayDate,
    print_user: claims.sub,
  };
  if (docType === "addendum") dvUpdate.print_status = 1;
  else if (docType === "infosheet") dvUpdate.print_info = 1;
  else if (docType === "buyer_guide") dvUpdate.print_guide = 1;
  let { error: dvUpdateErr } = await admin
    .from("dealer_vehicles")
    .update(dvUpdate)
    .eq("id", dealerVehicleId);
  // Pre-migration-055 safety net: dealer_vehicles.print_user was varchar(20)
  // and rejected 36-char UUIDs, rolling back the whole atomic UPDATE — which
  // is why print_status / print_date never landed. Retry without print_user
  // so the canonical print_status fields still flip even before migration 055
  // is applied. Once the column is widened to text, the first try succeeds.
  if (dvUpdateErr && /too long/i.test(dvUpdateErr.message)) {
    const { print_user: _omit, ...withoutUser } = dvUpdate;
    void _omit;
    const retry = await admin
      .from("dealer_vehicles")
      .update(withoutUser)
      .eq("id", dealerVehicleId);
    dvUpdateErr = retry.error;
  }
  if (dvUpdateErr) console.error("[pdf/generate] dealer_vehicles print update failed:", dvUpdateErr.message);

  await admin.from("vehicle_audit_log").insert({
    dealer_id: dv.dealer_id,
    vehicle_id: dealerVehicleId,
    stock_number: dv.stock_number,
    action: "print",
    method: "print",
    changed_by: claims.sub,
    document_type: docType,
  } as VehicleAuditLogInsert);

  if (dealer?.id && options.length > 0) {
    const printedAt = new Date().toISOString();
    const adRows: AddendumDataInsert[] = options.map((o, i) => ({
      dealer_id: dealer.id,
      legacy_dealer_id: dv.dealer_id,
      vehicle_id: dealerVehicleId,
      vin_number: dv.vin,
      item_name: o.option_name,
      item_description: o.description ?? null,
      item_price: o.option_price ?? null,
      active: "1",
      or_or_ad: 1,
      order_by: i,
      separator_spaces: 2,
      editable: 1,
      printed_at: printedAt,
      document_type: docType,
      s3_key: uploadedKey,
      required: o.required !== false,
    }));
    const { error: adErr } = await admin.from("addendum_data").insert(adRows);
    if (adErr) console.error("[pdf/generate] addendum_data insert failed:", adErr.message);
  }

  // Refresh the save-state slice of addendum_data (legacy_id IS NULL, no
  // s3_key, no printed_at) with what was just printed. Only the addendum
  // doc type contributes the dealer's "current product set" — infosheet and
  // buyer-guide prints aren't product-set events. The print-event rows above
  // (with printed_at + s3_key) are independent and preserved.
  if (docType === "addendum" && dealer?.id) {
    await syncAddendumItems(admin, {
      vehicleId: dealerVehicleId,
      dealerId: dealer.id,
      legacyDealerId: dv.dealer_id,
      vin: dv.vin,
      documentType: "addendum",
      products: options.map(o => ({
        name: o.option_name,
        price: o.option_price,
        description: o.description ?? null,
        required: o.required !== false,
      })),
    });
  }

  const today = new Date().toISOString().split("T")[0];
  const historyRows: AddendumHistoryInsert[] = options.map((o, i) => ({
    legacy_id: null,
    vehicle_id: null,
    vin: dv.vin,
    dealer_id: dv.dealer_id,
    item_name: o.option_name,
    item_description: null,
    item_price: o.option_price ?? null,
    active: "Yes",
    creation_date: today,
    order_by: i,
    source: "platform",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  if (historyRows.length > 0) {
    await admin.from("addendum_history").insert(historyRows);
  }
}
import {
  BG_DEFAULT,
  IS_BG_DEFAULT,
  LAYOUT,
  LAYOUT_INFOSHEET,
  makeWidget,
} from "@/components/builder/constants";
import { getGroupOptionsForDealer, getGroupDisclaimers, matchesRulesRow } from "@/lib/options-engine";
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
      .select("id, dealer_id, internal_id, name, address, city, state, zip, phone, logo_url")
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

    // For options missing a description, fall back to addendum_library by name.
    // Also load required + layout (separator_above/below, spaces) so the
    // renderer can honor the dealer's library-side formatting on every print.
    // The library rules (Make/Model/Year/...) also gate the saved options at
    // print time — if a saved option's library row exists but doesn't match
    // the vehicle, it's dropped here. Library rules trump saved state by design.
    const allOptNames = (optionRows ?? []).map(r => r.option_name as string);
    const nullDescNames = (optionRows ?? [])
      .filter(r => !r.description)
      .map(r => r.option_name as string);
    const libDescMap: Record<string, string | null> = {};
    const libRequiredMap: Record<string, boolean> = {};
    const libLayoutMap: Record<string, { separator_above: boolean; separator_below: boolean; spaces: number }> = {};
    const libRuleByName = new Map<string, Parameters<typeof matchesRulesRow>[0]>();
    if (allOptNames.length > 0) {
      const { data: libRows } = await admin
        .from("addendum_library")
        .select("option_name, description, required, separator_above, separator_below, spaces, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2")
        .eq("dealer_id", dv.dealer_id)
        .in("option_name", allOptNames);
      for (const lr of libRows ?? []) {
        const name = lr.option_name as string;
        if (nullDescNames.includes(name) && lr.description) libDescMap[name] = lr.description as string;
        if (lr.required === false) libRequiredMap[name] = false;
        libLayoutMap[name] = {
          separator_above: lr.separator_above === true,
          separator_below: lr.separator_below === true,
          spaces: typeof lr.spaces === "number" ? lr.spaces : 0,
        };
        libRuleByName.set(name, {
          applies_to: lr.applies_to as string | null,
          ad_types: lr.ad_types as string[] | null,
          makes: lr.makes as string | null,
          makes_not: (lr.makes_not as boolean | null) ?? false,
          models: lr.models as string | null,
          models_not: (lr.models_not as boolean | null) ?? false,
          trims: lr.trims as string | null,
          trims_not: (lr.trims_not as boolean | null) ?? false,
          body_styles: lr.body_styles as string | null,
          year_condition: (lr.year_condition as number | null) ?? 0,
          year_value: lr.year_value as number | null,
          miles_condition: (lr.miles_condition as number | null) ?? 0,
          miles_value: lr.miles_value as number | null,
          msrp_condition: (lr.msrp_condition as number | null) ?? 0,
          msrp1: lr.msrp1 as number | null,
          msrp2: lr.msrp2 as number | null,
        });
      }
    }

    const disclaimers = await getGroupDisclaimers(textDealerId, dealer?.state ?? null, docType);

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
      MILEAGE: dv.mileage != null ? String(dv.mileage) : null,
      DATE_IN_STOCK: dv.date_added,
      STATUS: "1" as const,
      MSRP: dv.msrp != null ? String(dv.msrp) : null,
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

    // ── Corporate (group) products, rules-filtered for this vehicle ──────────
    const groupOpts = await getGroupOptionsForDealer(textDealerId, vehicleData, dealerVehicleId);

    // Drop saved options whose library row exists but doesn't match this
    // vehicle. Custom saves (no library row) are kept.
    const savedFiltered = (optionRows ?? []).filter(r => {
      const rule = libRuleByName.get(r.option_name as string);
      if (!rule) return true;
      return matchesRulesRow(rule, vehicleData);
    });

    const options = [
      ...groupOpts.map(g => ({
        option_name: g.option_name,
        option_price: g.option_price,
        description: g.description,
        active: true as const,
        // Honor the corporate product's Required/Suggested flag — locked-assigned
        // Suggested products are still rendered in the Suggested section.
        required: g.required,
        separator_above: g.separator_above === true,
        separator_below: g.separator_below === true,
        spaces: g.spaces ?? 0,
      })),
      ...savedFiltered.map(r => {
        const layout = libLayoutMap[r.option_name as string];
        return {
          ...r,
          description: r.description ?? libDescMap[r.option_name as string] ?? null,
          // Library required=false takes precedence over stale vehicle_options value
          required: libRequiredMap[r.option_name as string] === false
            ? false
            : (r.required as boolean | undefined) !== false,
          separator_above: layout?.separator_above === true,
          separator_below: layout?.separator_below === true,
          spaces: layout?.spaces ?? 0,
        };
      }),
    ];

    // ── Load dealer's saved default template from dealer_settings ────────────
    // Only runs when no widgets were supplied by the caller (i.e. Print Now,
    // not a Builder print which passes its own widget layout).
    let savedTemplateWidgets: Widget[] | null = null;
    let savedTemplateBgUrl: string | undefined;
    let savedTemplateFontScale: number | undefined;
    let savedTemplatePaperSize: PaperSize | undefined;
    let aiEnabled = true; // default: AI mode per platform default

    if (!inWidgets || inWidgets.length === 0) {
      const { data: settings } = await admin
        .from("dealer_settings")
        .select([
          "default_addendum_new", "default_addendum_used", "default_addendum_cpo",
          "default_infosheet_new", "default_infosheet_used", "default_infosheet_cpo",
          "default_buyersguide_new", "default_buyersguide_used", "default_buyersguide_cpo",
          "ai_content_default",
        ].join(", "))
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle<DealerSettingsRow>();

      if (settings) {
        aiEnabled = settings.ai_content_default ?? true;
        const condKey = dv.condition === "New" ? "new" : dv.condition === "Used" ? "used" : "cpo";
        const docKey = docType === "buyer_guide" ? "buyersguide" : docType;
        const col = `default_${docKey}_${condKey}` as keyof DealerSettingsRow;
        // Fallback: if no template set for this specific condition, try any condition for this doc type.
        // Prevents falling back to LAYOUT_INFOSHEET defaults when the user saved a template for a
        // different condition (e.g., saved for "new" but printing a "used" vehicle).
        const templateId = (settings[col] as string | null)
          ?? (settings[`default_${docKey}_new`] as string | null)
          ?? (settings[`default_${docKey}_used`] as string | null)
          ?? (settings[`default_${docKey}_cpo`] as string | null);

        if (templateId) {
          // The selected default may be a dealer template OR a group
          // template — dealer_settings.default_* no longer FK-references
          // a specific table (migration 065). Try templates first, then
          // fall through to group_templates.
          let tmpl: { template_json: Record<string, unknown> } | null = null;
          const ownRes = await admin
            .from("templates")
            .select("template_json")
            .eq("id", templateId)
            .maybeSingle<{ template_json: Record<string, unknown> }>();
          tmpl = ownRes.data;
          if (!tmpl) {
            const grpRes = await admin
              .from("group_templates")
              .select("template_json")
              .eq("id", templateId)
              .maybeSingle<{ template_json: Record<string, unknown> }>();
            tmpl = grpRes.data;
          }

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

      // Fallback: if no default infosheet template configured in dealer_settings, use any active infosheet template
      if (!savedTemplateWidgets && docType === 'infosheet') {
        const { data: fallbackTmpl } = await admin
          .from("templates")
          .select("template_json")
          .eq("dealer_id", dv.dealer_id)
          .eq("document_type", "infosheet")
          .eq("is_active", true)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle<{ template_json: Record<string, unknown> }>();

        if (fallbackTmpl?.template_json) {
          const ftj = fallbackTmpl.template_json as {
            widgets?: Record<string, Widget>;
            bgUrl?: string;
            fontScale?: number;
            paperSize?: string;
          };
          if (ftj.widgets && Object.keys(ftj.widgets).length > 0) {
            savedTemplateWidgets = Object.values(ftj.widgets);
          }
          if (ftj.bgUrl) savedTemplateBgUrl = ftj.bgUrl;
          if (typeof ftj.fontScale === "number") savedTemplateFontScale = ftj.fontScale;
          if (ftj.paperSize) savedTemplatePaperSize = ftj.paperSize as PaperSize;
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
        const vin   = dv.vin ?? '';
        const stock = dv.stock_number ?? '';

        if (w.type === 'infobox' && (w.d.ibType as string) === 'qr') {
          const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
          const qrUrl = dv.vdp_link ?? (tmplStr
            ? tmplStr.replace('[VIN]', vin).replace('[STOCK]', stock)
            : null);
          if (!qrUrl) return w;
          try {
            const dataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
            return { ...w, d: { ...w.d, imgUrl: dataUrl } };
          } catch { return w; }
        }

        if (w.type === 'qrcode') {
          // Pre-generate QR as server-side data URL — eliminates external api.qrserver.com dependency
          const tmplStr = (w.d.qrUrlTemplate as string) || dealerQrTemplate || null;
          const resolvedTmpl = tmplStr ? tmplStr.replace('[VIN]', vin).replace('[STOCK]', stock) : null;
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

    // ── Fetch AI content for infosheet description/features + {{ai.}} tokens ───
    // Always fetch for infosheet PDFs — ai_content_default controls preference (AI vs DB),
    // but we always want content available so placeholders never appear in generated PDFs.
    let aiContent: { description: string; features: [string, string][] } | null = null;
    const needsAiForInfosheet = isInfosheet; // always, not gated by aiEnabled
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
            msrp: vehicleData.MSRP ? parseFloat(vehicleData.MSRP) : null,
          }, null);
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

    console.log('[pdf/generate] aiEnabled:', aiEnabled, 'aiContent:', aiContent ? 'yes' : 'none', 'dbDescription:', vehicleData.DESCRIPTION ? 'yes' : 'null', 'dbOptions:', (dv as Record<string, unknown>).options ? 'yes' : 'null');

    // ── Apply {{token}} patterns in customtext widgets ─────────────────────────
    if (widgets.some(w => w.type === 'customtext' && ((w.d.text as string) || '').includes('{{'))) {
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
      disclaimers,
      dealerLogoUrl,
      dealer: dealer ? { name: dealer.name, address: dealer.address, city: dealer.city, state: dealer.state, zip: dealer.zip, phone: dealer.phone } : undefined,
      customDims: customPaperDims,
      aiEnabled,
      aiDescription: aiContent?.description ?? null,
      aiFeatures: (aiContent?.features as [string, string][] | undefined) ?? null,
      dbDescription: vehicleData.DESCRIPTION ?? null,
      dbOptionsText: (dv as Record<string, unknown>).options as string | null ?? null,
    });

    const s3Key = buildPdfKey({
      internalId: dealer?.internal_id ?? null,
      dealerIdFallback: dv.dealer_id,
      vehicleUuid: dealerVehicleId,
      vin: dv.vin,
      docType,
    });

    // Phase E: async mode. Browser sends ?async=1 to get a jobId back
    // immediately, then polls /api/pdf/status/:jobId for completion.
    // Only meaningful when the service path is on — the local Puppeteer
    // path doesn't know about jobs, so it falls through to the sync
    // bytes response below.
    //
    // logGeneratePdf still has to run (print_history, dealer_vehicles
    // print flags, audit log) — we fire-and-forget a poller in the
    // background that fetches the rendered buffer once the service
    // marks complete and then runs the existing side-effect pipeline.
    // From the user's perspective the print is "done" the moment the
    // signed URL loads; the DB write happens shortly after.
    const asyncMode = req.nextUrl.searchParams.get("async") === "1";
    if (asyncMode && usePdfService()) {
      try {
        const { jobId } = await enqueueGenerate(html, {
          paperSize: effectivePaperSizeStr,
          customDims: customPaperDims,
        }, s3Key);
        // Fire-and-forget completion: poll the EXISTING jobId (not a
        // new render), fetch bytes once complete, run the logging
        // pipeline. Closure captures scope vars so no re-query.
        void (async () => {
          try {
            const result = await awaitJobAndFetch(jobId);
            await logGeneratePdf(result.buffer, s3Key, dealerVehicleId, dv, dealer, claims, docType, options, admin);
          } catch (err) {
            console.error("[pdf/generate async] completion failed for job", jobId, err instanceof Error ? err.message : err);
          }
        })();
        return NextResponse.json({
          jobId,
          statusUrl: `/api/pdf/status/${jobId}`,
          s3Key,
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
      // The service uploads to s3Key itself; logGeneratePdf below
      // re-uploads via uploadPdf() so the DB row pdf_url is the
      // canonical 24h signed URL from s3-upload.ts. Second PUT is a
      // no-op overwrite of identical bytes.
      const result = await renderViaService(html, {
        paperSize: effectivePaperSizeStr,
        customDims: customPaperDims,
      }, s3Key);
      pdfBuffer = result.buffer;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "PDF render failed" }, { status: 500 });
    }

    // S3 upload + all DB logging happen in the background — PDF bytes returned immediately
    void logGeneratePdf(pdfBuffer, s3Key, dealerVehicleId, dv, dealer, claims, docType, options, admin)
      .catch(err => console.error("[pdf/generate] background logging error:", err instanceof Error ? err.message : err));

    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(pdfBuffer.length),
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[pdf/generate]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
