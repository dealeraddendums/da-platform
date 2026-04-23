import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert, AddendumHistoryInsert, DealerSettingsRow } from "@/lib/db";
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

  const { dealerVehicleId, widgets: inWidgets, paperSize = "standard", fontScale = 1.0, docType = "addendum" } = body;

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
      .select("dealer_id, name, address, city, state, zip, phone, logo_url")
      .eq("dealer_id", dv.dealer_id)
      .maybeSingle();

    // dealer.dealer_id is the text ID used by group options / disclaimers
    const textDealerId = dealer?.dealer_id ?? "";

    // ── Options from Supabase — descriptions come directly from the rows ──────
    const { data: optionRows } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", 0)
      .eq("dealer_id", dv.dealer_id)
      .order("sort_order");

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
        description: r.description ?? null,
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

    // ── Build widget layout ───────────────────────────────────────────────────
    const effectivePaperSize: PaperSize = savedTemplatePaperSize ?? paperSize;
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

    // ── Render and upload ─────────────────────────────────────────────────────
    const bgUrl = body.bgUrl || savedTemplateBgUrl || (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
    const html = buildPdfHtml({
      widgets,
      paperSize: effectivePaperSize,
      fontScale: effectiveFontScale,
      bgUrl,
      vehicle: vehicleData,
      options,
      disclaimer: disclaimer ?? undefined,
    });

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderPdf(html, effectivePaperSize);
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
