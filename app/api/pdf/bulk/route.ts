import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getPool } from "@/lib/aurora";
import { createAdminSupabaseClient } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { renderPdf } from "@/lib/pdf-renderer";
import { uploadPdf } from "@/lib/s3-upload";
import { BG_DEFAULT, IS_BG_DEFAULT, LAYOUT, LAYOUT_INFOSHEET, makeWidget } from "@/components/builder/constants";
import type { Widget, PaperSize } from "@/components/builder/types";
import type { VehicleRow } from "@/lib/vehicles";
import type { RowDataPacket } from "mysql2";
import JSZip from "jszip";

type VehicleDimRow = VehicleRow & {
  DEALER_NAME: string | null;
  DEALER_ADDRESS: string | null;
  DEALER_CITY: string | null;
  DEALER_STATE: string | null;
  DEALER_ZIP: string | null;
  DEALER_PHONE: string | null;
  logo_url: string | null;
} & RowDataPacket;

/**
 * POST /api/pdf/bulk
 * Generates PDFs for multiple vehicles, bundles into a ZIP, returns download stream.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  let body: {
    vehicleIds: number[];
    docType?: "addendum" | "infosheet" | "buyer_guide";
    paperSize?: PaperSize;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vehicleIds, docType = "addendum", paperSize: reqPaperSize } = body;
  if (!vehicleIds?.length) {
    return NextResponse.json({ error: "vehicleIds required" }, { status: 400 });
  }
  if (vehicleIds.length > 50) {
    return NextResponse.json({ error: "Maximum 50 vehicles per bulk request" }, { status: 400 });
  }

  const paperSize: PaperSize = reqPaperSize ?? (docType === "infosheet" ? "infosheet" : "standard");
  const isInfosheet = paperSize === "infosheet";
  const bgUrl = isInfosheet ? IS_BG_DEFAULT : BG_DEFAULT;

  const pool = getPool();
  const admin = createAdminSupabaseClient();
  const zip = new JSZip();

  const results: { vehicleId: number; pdfUrl?: string; error?: string }[] = [];

  // Process vehicles sequentially to avoid memory spikes
  for (const vehicleId of vehicleIds) {
    try {
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
        results.push({ vehicleId, error: "not found" });
        continue;
      }
      const v = rows[0];

      // TODO: verify this should use inventory_dealer_id (claims.dealer_id is Supabase; v.DEALER_ID is Aurora)
      if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
        if (v.DEALER_ID !== claims.dealer_id) {
          results.push({ vehicleId, error: "forbidden" });
          continue;
        }
      }

      const { data: optionRows } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", vehicleId)
        .eq("active", true)
        .order("sort_order");
      const options = optionRows ?? [];

      // Build default widget layout
      const layout = isInfosheet ? LAYOUT_INFOSHEET : LAYOUT;
      const order = isInfosheet
        ? ["logo", "vehicle", "description", "features", "askbar", "qrcode", "barcode", "dealer", "customtext"]
        : ["logo", "vehicle", "msrp", "options", "subtotal", "askbar", "dealer", "infobox"];
      let nid = 1;
      const widgets: Widget[] = order
        .filter(t => layout[t])
        .map(t => {
          const id = "w" + nid++;
          const w = makeWidget(t, id, undefined, undefined, undefined, undefined, isInfosheet);
          if (t === "msrp" && v.MSRP) {
            const msrp = parseFloat(v.MSRP);
            if (!isNaN(msrp)) w.d = { ...w.d, value: `$${msrp.toLocaleString()}` };
          }
          if (t === "dealer") {
            const lines = [
              v.DEALER_NAME,
              v.DEALER_ADDRESS,
              [v.DEALER_CITY, v.DEALER_STATE, v.DEALER_ZIP].filter(Boolean).join(" "),
              v.DEALER_PHONE,
            ].filter(Boolean);
            if (lines.length) w.d = { ...w.d, text: lines.join("\n") };
          }
          if (t === "logo" && v.logo_url) w.d = { ...w.d, imgUrl: v.logo_url };
          if (t === "askbar") {
            const msrp = v.MSRP ? parseFloat(v.MSRP) : 0;
            const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
            const ask = msrp + optTotal;
            if (ask > 0) w.d = { ...w.d, value: `$${ask.toLocaleString()}` };
          }
          if (t === "subtotal") {
            const optTotal = options.reduce((s, o) => s + (parseFloat(o.option_price) || 0), 0);
            if (optTotal > 0) w.d = { ...w.d, value: `$${optTotal.toLocaleString()}` };
          }
          return w;
        });

      const html = buildPdfHtml({ widgets, paperSize, fontScale: 1.0, bgUrl, vehicle: v, options });
      const pdfBuffer = await renderPdf(html, paperSize);

      const timestamp = Date.now();
      const s3Key = `${v.DEALER_ID}/${vehicleId}/${timestamp}.pdf`;
      const pdfUrl = await uploadPdf(pdfBuffer, s3Key);

      await admin.from("print_history").insert({
        vehicle_id: vehicleId,
        dealer_id: v.DEALER_ID,
        document_type: docType,
        printed_by: claims.sub,
        pdf_url: pdfUrl,
      });

      const fileName = `${v.STOCK_NUMBER || vehicleId}_${v.YEAR ?? ""}_${v.MAKE ?? ""}_${v.MODEL ?? ""}.pdf`
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_.-]/g, "");
      zip.file(fileName, pdfBuffer);
      results.push({ vehicleId, pdfUrl });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      results.push({ vehicleId, error: msg });
    }
  }

  const succeeded = results.filter(r => !r.error);
  if (!succeeded.length) {
    return NextResponse.json({ error: "All vehicles failed", results }, { status: 500 });
  }

  // If only one vehicle succeeded, return the URL directly
  if (succeeded.length === 1) {
    return NextResponse.json({ url: succeeded[0].pdfUrl, results });
  }

  // Bundle into ZIP
  const zipBuffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new NextResponse(zipBuffer as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="addendums_${Date.now()}.zip"`,
      "Content-Length": String((zipBuffer as ArrayBuffer).byteLength),
    },
  });
}
