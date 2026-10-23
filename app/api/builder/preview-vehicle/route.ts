import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { resolveVehiclePrintOptions } from "@/lib/print-options";
import { printedOptionItem } from "@/lib/pdf-html";
import { parseOptionPriceValue, priceSetUsesDecimals } from "@/lib/option-price";
import { resolveVehicleCondition } from "@/lib/vehicles";

/* eslint-disable @typescript-eslint/no-explicit-any */
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Template Builder "As vehicle" preview.
 *   GET ?dealer_id=&q=<stock / VIN / model>  → { vehicles: [{ id, stock, label, condition }] } (12 max)
 *   GET ?dealer_id=&vehicle_id=<uuid>          → { vehicle, condition, required, suggested }
 * The products are resolved by lib/print-options.ts — the exact code POST /api/pdf/generate prints with —
 * and mapped by pdf-html's printedOptionItem, so the canvas shows that vehicle's real set and prices.
 * Read-only: nothing is saved (print's save-on-print never runs here).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  const sp = req.nextUrl.searchParams;
  const authz = await authorizeDealerAction(claims, sp.get("dealer_id") ?? claims.dealer_id);
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;
  const admin = createAdminSupabaseClient() as any;

  const vehicleId = sp.get("vehicle_id");
  if (!vehicleId) {
    const q = (sp.get("q") ?? "").trim().replace(/[%_,()\\]/g, " ").slice(0, 40);
    let query = admin.from("dealer_vehicles").select("id, stock_number, vin, year, make, model, trim, condition, certified")
      .eq("dealer_id", dealerId).order("date_added", { ascending: false, nullsFirst: false }).limit(12);
    if (q) query = query.or(`stock_number.ilike.%${q}%,vin.ilike.%${q}%,model.ilike.%${q}%`);
    const { data, error: qErr } = await query;
    if (qErr) return NextResponse.json({ error: qErr.message }, { status: 500 });
    return NextResponse.json({
      vehicles: (data ?? []).map((v: any) => ({
        id: v.id, stock: v.stock_number, condition: resolveVehicleCondition(v),
        label: [v.year, v.make, v.model, v.trim].filter(Boolean).join(" "),
      })),
    });
  }

  if (!UUID.test(vehicleId)) return NextResponse.json({ error: "Bad vehicle_id" }, { status: 400 });
  const { data: dv } = await admin.from("dealer_vehicles").select("*").eq("id", vehicleId).eq("dealer_id", dealerId).maybeSingle();
  if (!dv) return NextResponse.json({ error: "Vehicle not found in this dealer's inventory" }, { status: 404 });
  const { data: settings } = await admin.from("dealer_settings").select("always_show_cents").eq("dealer_id", dealerId).maybeSingle();

  const { vehicleData, options } = await resolveVehiclePrintOptions(admin, dv, vehicleId, dealerId);
  // Same split + decimals rule as buildPdfHtml (without a Retail/Wholesale ask price, which only exists
  // at Print Now).
  const all = (options as any[]).filter((o) => o.active !== false);
  const required = all.filter((o) => o.required !== false), suggested = all.filter((o) => o.required === false);
  const msrp = vehicleData.MSRP != null && Number.isFinite(parseFloat(vehicleData.MSRP)) ? parseFloat(vehicleData.MSRP) : null;
  const reqTotal = required.reduce((s, o) => s + parseOptionPriceValue(o.option_price), 0);
  const allTotal = all.reduce((s, o) => s + parseOptionPriceValue(o.option_price), 0);
  const decimals = settings?.always_show_cents === true || priceSetUsesDecimals([
    msrp, reqTotal, (msrp ?? 0) + reqTotal, (msrp ?? 0) + allTotal, ...all.map((o) => parseOptionPriceValue(o.option_price)),
  ]);
  return NextResponse.json({
    vehicle: { id: dv.id, stock: dv.stock_number, label: [dv.year, dv.make, dv.model, dv.trim].filter(Boolean).join(" ") },
    condition: resolveVehicleCondition(dv),
    required: required.map((o) => printedOptionItem(o, decimals)),
    suggested: suggested.map((o) => printedOptionItem(o, decimals)),
  });
}
