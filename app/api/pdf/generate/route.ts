import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { DealerSettingsRow } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { buildPdfKey } from "@/lib/s3-upload";
import { useService as usePdfService, renderViaService, enqueueGenerate, type PdfDocTypeTag } from "@/lib/pdf-service-client";
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
import { getGroupOptionsForDealer, getGroupDisclaimers, matchesRulesRow, savedRowSurvivesLibraryRules, normalizeOptionName, buildLiveRequiredByName, newlyAddedLibraryMatches, autoMatchedLibraryRows } from "@/lib/options-engine";
import type { SaveOption } from "@/lib/vehicle-options-save";
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
    //
    // The library is fetched WHOLE (not name-scoped) and joined by
    // normalizeOptionName: saved names can differ from library names by the
    // legacy trailing-"^" marker, and the newly-added-product merge below
    // needs rows whose names aren't saved yet.
    type GenLibRow = {
      id: string;
      option_name: string;
      item_price: string | null;
      description: string | null;
      required: boolean | null;
      active: boolean | null;
      created_at: string | null;
      separator_above: boolean | null;
      separator_below: boolean | null;
      spaces: number | null;
      applies_to: string | null;
      ad_types: string[] | null;
      makes: string | null;
      makes_not: boolean | null;
      models: string | null;
      models_not: boolean | null;
      trims: string | null;
      trims_not: boolean | null;
      body_styles: string | null;
      fuel: string | null;
      fuel_not: boolean | null;
      year_condition: number | null;
      year_value: number | null;
      miles_condition: number | null;
      miles_value: number | null;
      msrp_condition: number | null;
      msrp1: number | null;
      msrp2: number | null;
    };
    let dealerLib: GenLibRow[] = [];
    const libDescMap: Record<string, string | null> = {};
    const libLayoutMap: Record<string, { separator_above: boolean; separator_below: boolean; spaces: number }> = {};
    // Keyed by normalized option_name → ARRAY of rules: a dealer can have
    // multiple library rows with the same name (e.g. an accidental duplicate).
    // Collapsing them to one (Map<name, rule>) let a misconfigured "applies to
    // none" duplicate win the slot and drop the real product at print time
    // (KARR-on-Maverick bug).
    const libRulesByName = new Map<string, Parameters<typeof matchesRulesRow>[0][]>();
    // Load the library unconditionally (was gated on optionRows>0): the
    // never-saved SEED below needs it so single-generate renders matched
    // products just like the editor + pdf/bulk (save-on-print, 2026-08-01).
    {
      const { data: libRows } = await admin
        .from("addendum_library")
        .select("id, option_name, item_price, description, required, active, created_at, separator_above, separator_below, spaces, applies_to, ad_types, makes, makes_not, models, models_not, trims, trims_not, body_styles, fuel, fuel_not, year_condition, year_value, miles_condition, miles_value, msrp_condition, msrp1, msrp2")
        .eq("dealer_id", dv.dealer_id)
        .order("sort_order", { ascending: true });
      dealerLib = (libRows ?? []) as unknown as GenLibRow[];
      for (const lr of dealerLib) {
        const name = normalizeOptionName(lr.option_name);
        if (lr.description && libDescMap[name] === undefined) libDescMap[name] = lr.description;
        if (libLayoutMap[name] === undefined) {
          libLayoutMap[name] = {
            separator_above: lr.separator_above === true,
            separator_below: lr.separator_below === true,
            spaces: typeof lr.spaces === "number" ? lr.spaces : 0,
          };
        }
        // Raw rule rows — savedRowSurvivesLibraryRules normalizes the
        // "-NONE"/"NONE"/empty auto-add sentinels and keeps applies_to='none'
        // manual-only products at compare time. libRulesByName is used only
        // for the savedFiltered gate below, so auto-add (which reads the raw
        // addendum_library value elsewhere) is unaffected.
        const ruleRow = {
          applies_to: lr.applies_to,
          ad_types: lr.ad_types,
          makes: lr.makes,
          makes_not: lr.makes_not ?? false,
          models: lr.models,
          models_not: lr.models_not ?? false,
          trims: lr.trims,
          trims_not: lr.trims_not ?? false,
          body_styles: lr.body_styles,
          fuel: lr.fuel,
          fuel_not: lr.fuel_not ?? false,
          year_condition: lr.year_condition ?? 0,
          year_value: lr.year_value,
          miles_condition: lr.miles_condition ?? 0,
          miles_value: lr.miles_value,
          msrp_condition: lr.msrp_condition ?? 0,
          msrp1: lr.msrp1,
          msrp2: lr.msrp2,
        };
        const existingRules = libRulesByName.get(name);
        if (existingRules) existingRules.push(ruleRow);
        else libRulesByName.set(name, [ruleRow]);
      }
    }
    // Live Required/Suggested flag — the library's current value always wins
    // over the value cached on vehicle_options at save time.
    const liveRequired = buildLiveRequiredByName(dealerLib);

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
      FUEL: dv.fuel ?? null,
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
      HMPG: dv.hmpg ?? null,
      CMPG: dv.cmpg ?? null,
      MPG: dv.mpg ?? null,
    };

    // ── Corporate (group) products, rules-filtered for this vehicle ──────────
    const groupOpts = await getGroupOptionsForDealer(textDealerId, vehicleData, dealerVehicleId);

    // Drop saved options whose library row exists but doesn't match this
    // vehicle. Custom saves (no library row), applies_to='none' manual-only
    // products, and "-NONE" auto-add sentinels are kept — shared gate with
    // the options GET and pdf/bulk (savedRowSurvivesLibraryRules).
    const savedFiltered = (optionRows ?? []).filter(r =>
      savedRowSurvivesLibraryRules(libRulesByName.get(normalizeOptionName(r.option_name as string)) ?? [], vehicleData)
    );

    // Library products added AFTER this vehicle's last save that rules-match
    // it print too — same merge as the options GET, so Print Now includes a
    // newly-added product without requiring an editor visit. Removed products
    // predate the save and are not resurrected.
    const freshLibOptions = newlyAddedLibraryMatches(
      dealerLib,
      (optionRows ?? []) as Array<{ option_name: string; created_at?: string | null; updated_at?: string | null }>,
      vehicleData,
    );

    // Never-saved SEED: when the vehicle has NO saved options, render the matched
    // dealer-library set (source:"default"), exactly as the options GET editor +
    // pdf/bulk do — single-generate previously printed group-only for these.
    // applies_to='none' manual-only products are excluded (never auto-add);
    // legacy addendum_data vehicles are left to that path (the save-on-print
    // guard skips persisting them so the feed keeps its authoritative values).
    const seededMatches = (optionRows ?? []).length === 0
      ? autoMatchedLibraryRows(dealerLib, vehicleData)
      : [];

    const savedFilteredMapped = savedFiltered.map(r => {
      const key = normalizeOptionName(r.option_name as string);
      const layout = libLayoutMap[key];
      const live = liveRequired.get(key);
      return {
        ...r,
        description: r.description ?? libDescMap[key] ?? null,
        // Live library type wins over the value cached at save time; the
        // saved flag only applies to custom one-offs with no library row.
        required: live !== undefined ? live : (r.required as boolean | undefined) !== false,
        separator_above: layout?.separator_above === true,
        separator_below: layout?.separator_below === true,
        spaces: layout?.spaces ?? 0,
      };
    });

    const seededMapped = seededMatches.map(r => {
      const layout = libLayoutMap[normalizeOptionName(r.option_name)];
      return {
        option_name: r.option_name,
        option_price: r.option_price,
        description: r.description,
        active: true as const,
        required: r.required,
        separator_above: layout?.separator_above === true,
        separator_below: layout?.separator_below === true,
        spaces: layout?.spaces ?? 0,
      };
    });

    const freshLibMapped = freshLibOptions.map(r => ({
      option_name: r.option_name,
      option_price: r.item_price ?? "NC",
      description: r.description ?? null,
      active: true as const,
      required: r.required !== false,
      separator_above: r.separator_above === true,
      separator_below: r.separator_below === true,
      spaces: typeof r.spaces === "number" ? r.spaces : 0,
    }));

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
      ...savedFilteredMapped,
      ...freshLibMapped,
      ...seededMapped,
    ];

    // Save-on-print: the NON-group set to persist on confirm (saved-surviving +
    // newly-added + seed). Group products are excluded — they merge at read time.
    const saveOptions: SaveOption[] = [
      ...savedFilteredMapped.map(r => ({
        option_name: r.option_name as string,
        option_price: (r.option_price as string | null) ?? "NC",
        description: (r.description as string | null) ?? null,
        required: (r.required as boolean | undefined) !== false,
        source: ((r as { source?: string }).source) ?? "default",
      })),
      ...freshLibMapped.map(r => ({
        option_name: r.option_name,
        option_price: r.option_price,
        description: r.description,
        required: r.required,
        source: "default",
      })),
      ...seededMapped.map(r => ({
        option_name: r.option_name,
        option_price: r.option_price,
        description: r.description,
        required: r.required,
        source: "default",
      })),
    ];

    // ── Load dealer's saved default template from dealer_settings ────────────
    // Only runs when no widgets were supplied by the caller (i.e. Print Now,
    // not a Builder print which passes its own widget layout).
    let savedTemplateWidgets: Widget[] | null = null;
    let savedTemplateIsGroup = false;
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
            if (tmpl) savedTemplateIsGroup = true;
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

      // Fallback: no dealer/group default addendum template configured —
      // bootstrap from the SuperAdmin blank-default starter (the same layout
      // the Builder applies on first open and "+ New → Blank"), so Print Now
      // matches the Builder instead of the legacy hardcoded LAYOUT defaults.
      // Routed through savedTemplateWidgets so it gets the identical live-price
      // / dealer-logo / address normalization a real saved template gets.
      if (!savedTemplateWidgets && docType === "addendum") {
        // starter_templates isn't in the generated Database types yet; cast like
        // the /api/starter-templates routes do.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sdb = admin as any;
        const { data: blankStarter } = await sdb
          .from("starter_templates")
          .select("template_json")
          .eq("is_blank_default", true)
          .limit(1)
          .maybeSingle() as { data: { template_json: Record<string, unknown> } | null };
        if (blankStarter?.template_json) {
          const btj = blankStarter.template_json as {
            widgets?: Record<string, Widget>;
            bgUrl?: string;
            fontScale?: number;
            paperSize?: string;
          };
          if (btj.widgets && Object.keys(btj.widgets).length > 0) {
            savedTemplateWidgets = Object.values(btj.widgets);
          }
          if (btj.bgUrl) savedTemplateBgUrl = btj.bgUrl;
          if (typeof btj.fontScale === "number") savedTemplateFontScale = btj.fontScale;
          if (btj.paperSize) savedTemplatePaperSize = btj.paperSize as PaperSize;
        }
      }
    }

    // ── Resolve custom paper size dimensions ──────────────────────────────────
    let customPaperDims: { widthIn: number; heightIn: number } | undefined;
    let customSizeBgUrl: string | undefined;
    let customSizeDocType: 'addendum' | 'infosheet' | undefined;
    const knownSizes = new Set(['standard', 'narrow', 'infosheet']);
    const effectivePaperSizeStr = savedTemplatePaperSize ?? paperSize;
    if (!knownSizes.has(effectivePaperSizeStr)) {
      const { data: cs } = await admin
        .from("dealer_custom_sizes")
        .select("width_in, height_in, background_url, doc_type")
        .eq("id", effectivePaperSizeStr)
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle();
      if (cs) {
        customPaperDims = { widthIn: Number(cs.width_in), heightIn: Number(cs.height_in) };
        if (cs.background_url) customSizeBgUrl = cs.background_url;
        if (cs.doc_type === 'infosheet' || cs.doc_type === 'addendum') customSizeDocType = cs.doc_type;
      }
    }

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
      forceDealerLogo: savedTemplateIsGroup,
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
        const { jobId } = await enqueueGenerate(html, {
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
      const result = await renderViaService(html, {
        paperSize: effectivePaperSizeStr,
        customDims: customPaperDims,
        docType: docType as PdfDocTypeTag,
      }, s3Key);
      pdfBuffer = result.buffer;
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
