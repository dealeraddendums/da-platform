import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import { createAdminSupabaseClient } from "@/lib/db";
import type { VehicleAuditLogInsert } from "@/lib/db";
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
import type { VehicleRow } from "@/lib/vehicles";
import type { RowDataPacket } from "mysql2";

type DealerDimRow = {
  DEALER_NAME: string | null;
  DEALER_ADDRESS: string | null;
  DEALER_CITY: string | null;
  DEALER_STATE: string | null;
  DEALER_ZIP: string | null;
  DEALER_PHONE: string | null;
  logo_url: string | null;
} & RowDataPacket;

type VehicleDimRow = VehicleRow & DealerDimRow;

/**
 * POST /api/pdf/generate
 * Accepts either a full widget array (from builder) or uses the default layout.
 * Always fetches fresh options from Supabase and enriches vehicle widget.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    vehicleId?: number;
    dealerVehicleId?: string;
    vehicleData?: VehicleRow;
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

  const { vehicleId, dealerVehicleId, widgets: inWidgets, paperSize = "standard", fontScale = 1.0, docType = "addendum" } = body;

  if (!dealerVehicleId && vehicleId === undefined) {
    return NextResponse.json({ error: "vehicleId or dealerVehicleId required" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // ── Manual vehicle path (dealerVehicleId) ─────────────────────────────────────
  if (dealerVehicleId) { try {
    const { data: dv } = await admin
      .from("dealer_vehicles")
      .select("*")
      .eq("id", dealerVehicleId)
      .maybeSingle();
    if (!dv) return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });

    const effectiveDealerId = (claims as Record<string, unknown>).impersonating_dealer_id as string | null ?? claims.dealer_id;
    const isDealer = claims.role === "dealer_admin" || claims.role === "dealer_user";
    if (isDealer && effectiveDealerId && dv.dealer_id !== effectiveDealerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { data: dealer } = await admin
      .from("dealers")
      .select("name, address, city, state, zip, phone, logo_url, dealer_id")
      .eq("id", dv.dealer_id)
      .maybeSingle();

    const vehicleRow = {
      id: 0,
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
      STATUS: "1",
      MSRP: dv.msrp ? String(dv.msrp) : null,
      NEW_USED: dv.condition === "Used" ? "Used" : "New",
      CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
      OPTIONS: null,
      PHOTOS: null,
      DESCRIPTION: dv.description,
      PRINT_STATUS: "0",
      HMPG: null,
      CMPG: null,
      MPG: null,
      DEALER_NAME: dealer?.name ?? null,
      DEALER_ADDRESS: dealer?.address ?? null,
      DEALER_CITY: dealer?.city ?? null,
      DEALER_STATE: dealer?.state ?? null,
      DEALER_ZIP: dealer?.zip ?? null,
      DEALER_PHONE: dealer?.phone ?? null,
      logo_url: dealer?.logo_url ?? null,
    } as VehicleDimRow;

    const { data: optionRows } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", 0)
      .eq("dealer_id", dv.dealer_id)
      .order("sort_order");

    const groupOpts = await getGroupOptionsForDealer(dv.dealer_id);

    // Fetch descriptions from addendum_library (dealer_id is the Aurora text ID)
    const libDealerId = dealer?.dealer_id ?? null;
    const descMap = new Map<string, string>();
    if (libDealerId) {
      const { data: libRows } = await admin
        .from("addendum_library")
        .select("option_name, description")
        .eq("dealer_id", libDealerId)
        .eq("active", true);
      (libRows ?? []).forEach(r => { if (r.description) descMap.set(r.option_name, r.description); });
    }

    const options = [
      ...groupOpts.map(g => ({ option_name: g.option_name, option_price: g.option_price, active: true as const, description: descMap.get(g.option_name) })),
      ...(optionRows ?? []).map(r => ({ ...r, description: descMap.get(r.option_name) })),
    ];

    const disclaimer = await getGroupDisclaimer(dv.dealer_id, dealer?.state ?? null, docType);

    const isInfosheet = paperSize === "infosheet";
    let widgets: Widget[];
    if (inWidgets && inWidgets.length > 0) {
      widgets = inWidgets;
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
          if (t === "msrp" && vehicleRow.MSRP) {
            const msrp = parseFloat(vehicleRow.MSRP);
            if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
          }
          if (t === "dealer") {
            const lines = [vehicleRow.DEALER_NAME, vehicleRow.DEALER_ADDRESS,
              [vehicleRow.DEALER_CITY, vehicleRow.DEALER_STATE, vehicleRow.DEALER_ZIP].filter(Boolean).join(" "),
              vehicleRow.DEALER_PHONE].filter(Boolean);
            if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
          }
          if (t === "logo" && vehicleRow.logo_url) w.d = { ...w.d, imgUrl: vehicleRow.logo_url };
          if (t === "askbar") {
            const msrp = vehicleRow.MSRP ? parseFloat(vehicleRow.MSRP) : 0;
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

    const bgUrl = body.bgUrl || (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);
    const html = buildPdfHtml({ widgets, paperSize, fontScale, bgUrl, vehicle: vehicleRow, options, disclaimer: disclaimer ?? undefined });

    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await renderPdf(html, paperSize);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "PDF render failed" }, { status: 500 });
    }

    const timestamp = Date.now();
    const s3Key = `manual/${dv.dealer_id}/${dealerVehicleId}/${timestamp}.pdf`;

    let pdfUrl: string;
    try {
      pdfUrl = await uploadPdf(pdfBuffer, s3Key);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "S3 upload failed" }, { status: 500 });
    }

    await admin.from("vehicle_audit_log").insert({
      dealer_id: dv.dealer_id,
      vehicle_id: dealerVehicleId,
      stock_number: dv.stock_number,
      action: "print",
      changed_by: claims.sub,
      document_type: docType,
    } as VehicleAuditLogInsert);

    return NextResponse.json({ url: pdfUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[pdf/generate manual]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  } }

  // ── Aurora vehicle path ───────────────────────────────────────────────────────
  if (!vehicleId) {
    return NextResponse.json({ error: "vehicleId required" }, { status: 400 });
  }

  try {

  const effectiveDealerIdAurora = (claims as Record<string, unknown>).impersonating_dealer_id as string | null ?? claims.dealer_id;

  let vehicleRow: VehicleDimRow;

  if (body.vehicleData) {
    // Client already has vehicle data — fetch dealer from Supabase, skip Aurora
    const vd = body.vehicleData;
    if ((claims.role === "dealer_admin" || claims.role === "dealer_user") && effectiveDealerIdAurora && vd.DEALER_ID !== effectiveDealerIdAurora) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { data: dealer } = await admin
      .from("dealers")
      .select("name, address, city, state, zip, phone, logo_url")
      .eq("dealer_id", vd.DEALER_ID)
      .maybeSingle();
    vehicleRow = {
      ...vd,
      DEALER_NAME: dealer?.name ?? null,
      DEALER_ADDRESS: dealer?.address ?? null,
      DEALER_CITY: dealer?.city ?? null,
      DEALER_STATE: dealer?.state ?? null,
      DEALER_ZIP: dealer?.zip ?? null,
      DEALER_PHONE: dealer?.phone ?? null,
      logo_url: dealer?.logo_url ?? null,
    } as VehicleDimRow;
  } else {
    // Fall back to Aurora (e.g. builder route)
    const pool = getPool();
    const [rows] = await pool.query<VehicleDimRow[]>(
      `SELECT v.id, v.DEALER_ID, v.VIN_NUMBER, v.STOCK_NUMBER, v.YEAR, v.MAKE,
              v.MODEL, v.TRIM, v.EXT_COLOR, v.MILEAGE, v.MSRP, v.NEW_USED, v.CERTIFIED,
              v.BODYSTYLE, v.OPTIONS, v.PHOTOS, v.DESCRIPTION,
              v.STATUS, v.PRINT_STATUS, v.DATE_IN_STOCK, v.INT_COLOR,
              v.ENGINE, v.FUEL, v.DRIVETRAIN, v.TRANSMISSION, v.HMPG, v.CMPG, v.MPG,
              d.DEALER_NAME, d.DEALER_ADDRESS, d.DEALER_CITY, d.DEALER_STATE,
              d.DEALER_ZIP, d.DEALER_PHONE, d.logo_url
       FROM dealer_inventory v
       LEFT JOIN dealer_dim d ON d.DEALER_ID = v.DEALER_ID
       WHERE v.id = ? LIMIT 1`,
      [vehicleId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }
    vehicleRow = rows[0];
    if ((claims.role === "dealer_admin" || claims.role === "dealer_user") && effectiveDealerIdAurora && vehicleRow.DEALER_ID !== effectiveDealerIdAurora) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Fetch options from Supabase (always use real saved options)
  const { data: optionRows } = await admin
    .from("vehicle_options")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .eq("active", true)
    .order("sort_order");

  // Prepend locked group options
  const groupOpts = await getGroupOptionsForDealer(vehicleRow.DEALER_ID);

  // Fetch descriptions from Supabase addendum_library using claims dealer_id
  const auroraDescMap = new Map<string, string>();
  if (effectiveDealerIdAurora) {
    const { data: auroraLibRows } = await admin
      .from("addendum_library")
      .select("option_name, description")
      .eq("dealer_id", effectiveDealerIdAurora)
      .eq("active", true);
    (auroraLibRows ?? []).forEach(r => { if (r.description) auroraDescMap.set(r.option_name, r.description); });
  }

  const options = [
    ...groupOpts.map(g => ({ option_name: g.option_name, option_price: g.option_price, active: true as const, description: auroraDescMap.get(g.option_name) })),
    ...(optionRows ?? []).map(r => ({ ...r, description: auroraDescMap.get(r.option_name) })),
  ];

  // Fetch applicable group disclaimer
  const disclaimer = await getGroupDisclaimer(
    vehicleRow.DEALER_ID,
    (vehicleRow as Record<string, unknown>).DEALER_STATE as string | null,
    docType
  );

  // Build widget array — use provided or build default layout
  let widgets: Widget[];
  const isInfosheet = paperSize === "infosheet";

  if (inWidgets && inWidgets.length > 0) {
    widgets = inWidgets;
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
        // Inject real data into default widgets
        if (t === "msrp" && vehicleRow.MSRP) {
          const msrp = parseFloat(vehicleRow.MSRP);
          if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
        }
        if (t === "dealer") {
          const lines = [
            vehicleRow.DEALER_NAME,
            vehicleRow.DEALER_ADDRESS,
            [vehicleRow.DEALER_CITY, vehicleRow.DEALER_STATE, vehicleRow.DEALER_ZIP].filter(Boolean).join(" "),
            vehicleRow.DEALER_PHONE,
          ].filter(Boolean);
          if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
        }
        if (t === "logo" && vehicleRow.logo_url) {
          w.d = { ...w.d, imgUrl: vehicleRow.logo_url };
        }
        if (t === "askbar") {
          const msrp = vehicleRow.MSRP ? parseFloat(vehicleRow.MSRP) : 0;
          const optTotal = options.reduce((sum, o) => {
            const n = parseFloat(o.option_price);
            return sum + (isNaN(n) ? 0 : n);
          }, 0);
          const ask = msrp + optTotal;
          if (ask > 0) w.d = { ...w.d, value: `$${ask.toLocaleString()}` };
        }
        if (t === "subtotal") {
          const optTotal = options.reduce((sum, o) => {
            const n = parseFloat(o.option_price);
            return sum + (isNaN(n) ? 0 : n);
          }, 0);
          if (optTotal > 0) w.d = { ...w.d, value: `$${optTotal.toLocaleString()}` };
        }
        return w;
      });
  }

  const bgUrl =
    body.bgUrl ||
    (isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT);

  const html = buildPdfHtml({
    widgets,
    paperSize,
    fontScale,
    bgUrl,
    vehicle: vehicleRow,
    options,
    disclaimer: disclaimer ?? undefined,
  });

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderPdf(html, paperSize);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF render failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  const timestamp = Date.now();
  const s3Key = `${vehicleRow.DEALER_ID}/${vehicleId}/${timestamp}.pdf`;

  let pdfUrl: string;
  try {
    pdfUrl = await uploadPdf(pdfBuffer, s3Key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "S3 upload failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Log to print_history
  await admin.from("print_history").insert({
    vehicle_id: vehicleId,
    dealer_id: vehicleRow.DEALER_ID,
    document_type: docType,
    printed_by: claims.sub,
    pdf_url: pdfUrl,
  });

  return NextResponse.json({ url: pdfUrl });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    console.error("[pdf/generate Aurora]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
