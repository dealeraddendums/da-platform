import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { buildPdfHtml } from "@/lib/pdf-html";
import { renderPdf } from "@/lib/pdf-renderer";
import { uploadPdf } from "@/lib/s3-upload";
import { BG_DEFAULT, IS_BG_DEFAULT, LAYOUT, LAYOUT_INFOSHEET, makeWidget } from "@/components/builder/constants";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import type { Widget, PaperSize } from "@/components/builder/types";
import JSZip from "jszip";

/**
 * POST /api/pdf/bulk
 * Generates PDFs for multiple dealer_vehicles, bundles into a ZIP.
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

  const admin = createAdminSupabaseClient();
  const zip = new JSZip();
  const results: { vehicleId: string; pdfUrl?: string; error?: string }[] = [];

  for (const vehicleId of vehicleIds) {
    try {
      // ── Vehicle from Supabase dealer_vehicles ─────────────────────────────
      const { data: dv } = await admin
        .from("dealer_vehicles")
        .select("*")
        .eq("id", vehicleId)
        .maybeSingle();

      if (!dv) {
        results.push({ vehicleId, error: "not found" });
        continue;
      }

      if (claims.role === "dealer_admin" || claims.role === "dealer_user") {
        if (dv.dealer_id !== claims.dealer_id) {
          results.push({ vehicleId, error: "forbidden" });
          continue;
        }
      }

      // ── Dealer from Supabase dealers ──────────────────────────────────────
      const { data: dealer } = await admin
        .from("dealers")
        .select("dealer_id, name, address, city, state, zip, phone, logo_url")
        .eq("dealer_id", dv.dealer_id)
        .maybeSingle();

      // ── Options from Supabase ─────────────────────────────────────────────
      const { data: optionRows } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", 0)
        .eq("dealer_id", dv.dealer_id)
        .eq("active", true)
        .order("sort_order");

      // Fall back to addendum_library descriptions for options with null description
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

      const groupOpts = await getGroupOptionsForDealer(dv.dealer_id);
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

      // ── Map dealer_vehicles → VehicleRow shape ────────────────────────────
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
        DESCRIPTION: dv.description ?? null,
        HMPG: null,
        CMPG: null,
        MPG: null,
      };

      // ── Build widget layout ───────────────────────────────────────────────
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

      const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
      const rawLogo = dealer?.logo_url ?? null;
      const dealerLogoUrl = rawLogo
        ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo)
        : null;
      const html = buildPdfHtml({ widgets, paperSize, fontScale: 1.0, bgUrl, vehicle: vehicleData, options, dealerLogoUrl });
      const pdfBuffer = await renderPdf(html, paperSize);

      const timestamp = Date.now();
      const s3Key = `${dv.dealer_id}/${vehicleId}/${timestamp}.pdf`;
      const pdfUrl = await uploadPdf(pdfBuffer, s3Key);

      // ── Log to print_history ──────────────────────────────────────────────
      await admin.from("print_history").insert({
        vehicle_id: vehicleId,
        dealer_id:  dv.dealer_id,
        document_type: docType,
        printed_by: claims.sub,
        pdf_url:    pdfUrl,
      });

      const fileName = `${dv.stock_number || vehicleId}_${dv.year ?? ""}_${dv.make ?? ""}_${dv.model ?? ""}.pdf`
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

  if (succeeded.length === 1) {
    return NextResponse.json({ url: succeeded[0].pdfUrl, results });
  }

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
