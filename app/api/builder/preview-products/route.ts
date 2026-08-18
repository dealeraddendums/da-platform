import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import type { AddendumLibraryRow, GroupOptionRow } from "@/lib/db";
import { authorizeDealerAction } from "@/lib/dealer-authz";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import { formatOptionPrice, parseOptionPriceValue, priceSetUsesDecimals } from "@/lib/option-price";

// Builder-canvas product preview (extends the 66d3334 sample injection with
// REAL data). Returns the scope's actual products pre-mapped to the exact
// widget-item shape the PDF path builds (lib/pdf-html.ts d.items), so the
// canvas lays out against true content volume. CANVAS-ONLY consumer: the
// Builder injects these into renderW's argument at render time — never into
// widget d / saved template JSON, and the PDF path always overwrites d.items
// from the vehicle's real matched set (23d09ef guard class), so this data can
// never leak into prints.
//
// No vehicle exists while authoring, so which products would apply is
// unknowable — we return the ACTIVE superset for the scope (which is the
// point: authors size widgets to realistic volume). Capped at CAP per section
// (order_by first) so a dealer with dozens keeps a usable canvas; totals are
// returned so the client can label the cap.

// Cap is a payload guard only — the canvas clips visually and shows a
// "+N more · resize" indicator, so it can be generous.
const CAP = 40;

type PreviewCondition = "New" | "Used" | "CPO";

type PreviewItem = {
  name: string;
  desc: string;
  price: string;
  separator_above: boolean;
  separator_below: boolean;
  spaces: number;
  /** Which vehicle conditions this product COULD apply to (from the row's
   *  ad_types/ad_type condition rule; vehicle-specific rules like make/model/
   *  MSRP can't be evaluated without a vehicle, so this is the could-apply
   *  superset per condition). Drives the Builder's New/Used/CPO preview
   *  toggle — canvas-only, the print path still runs full matchesRulesRow. */
  conditions: PreviewCondition[];
};

/** Condition applicability from a product row's rules — mirrors the print
 *  evaluators' ad_types/ad_type handling (ad_types wins; legacy ad_type
 *  "New" → New only, "Used" → Used+CPO, else all). Non-'rules' rows
 *  (applies_to 'all'/'none') can appear on any condition. */
function rowConditions(
  appliesTo: string | null | undefined,
  adTypes: string[] | null | undefined,
  adType: string | null | undefined,
): PreviewCondition[] {
  const ALL: PreviewCondition[] = ["New", "Used", "CPO"];
  if (appliesTo !== "rules") return ALL;
  if (adTypes && adTypes.length > 0) return ALL.filter(c => adTypes.includes(c));
  const t = adType ?? "Both";
  if (t === "New") return ["New"];
  if (t === "Used") return ["Used", "CPO"];
  return ALL;
}

function splitAndMap<T>(
  rows: T[],
  isRequired: (r: T) => boolean,
  map: (r: T) => PreviewItem,
): { required: PreviewItem[]; suggested: PreviewItem[]; requiredTotal: number; suggestedTotal: number } {
  const req = rows.filter(isRequired);
  const sug = rows.filter(r => !isRequired(r));
  return {
    required: req.slice(0, CAP).map(map),
    suggested: sug.slice(0, CAP).map(map),
    requiredTotal: req.length,
    suggestedTotal: sug.length,
  };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const groupId = sp.get("group_id");
  const admin = createAdminSupabaseClient();

  // ── Group scope: the group's Corporate Products ─────────────────────────
  if (groupId) {
    // Same read rule as GET /api/group-options/[groupId]: super_admin any,
    // group roles their own group.
    const canRead = claims.role === "super_admin" || claims.group_id === groupId;
    if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { data, error: dbErr } = await admin
      .from("group_options")
      .select("*")
      .eq("group_id", groupId)
      .eq("active", true)
      .order("sort_order");
    if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 });

    const rows = (data ?? []) as GroupOptionRow[];
    // Group scope has no dealer_settings — use the whole-set decimals rule
    // (pdf-html parity: cents everywhere iff any price has cents).
    const decimals = priceSetUsesDecimals(rows.map(r => parseOptionPriceValue(r.option_price)));
    const split = splitAndMap(
      rows,
      // migration 053 `required` column; pre-backfill rows fall back to the
      // inverted is_suggested — same rule as the print merge (options-engine).
      r => (typeof r.required === "boolean" ? r.required : !r.is_suggested),
      r => ({
        name: r.option_name,
        desc: r.description ?? "",
        price: formatOptionPrice(r.option_price, decimals),
        separator_above: r.separator_above === true,
        separator_below: r.separator_below === true,
        spaces: typeof r.spaces === "number" ? r.spaces : 0,
        conditions: rowConditions(r.applies_to, r.ad_types, r.ad_type),
      }),
    );
    return NextResponse.json({ source: "group", cap: CAP, ...split });
  }

  // ── Dealer scope: dealer library + auto-applied corporate products ──────
  const authz = await authorizeDealerAction(claims, sp.get("dealer_id") ?? claims.dealer_id);
  if (!authz.ok) return authz.response;
  const dealerId = authz.dealerId;

  const [{ data: libData, error: libErr }, corp, dealerSettings] = await Promise.all([
    admin
      .from("addendum_library")
      .select("*")
      .eq("dealer_id", dealerId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    // Vehicle-less call = the dealer's assignment-scoped corporate superset
    // (rules filters only apply with a vehicle — exactly what we want here).
    getGroupOptionsForDealer(dealerId).catch(() => []),
    admin
      .from("dealer_settings")
      .select("always_show_cents")
      .eq("dealer_id", dealerId)
      .maybeSingle<{ always_show_cents: boolean | null }>()
      .then(r => r.data, () => null),
  ]);
  if (libErr) return NextResponse.json({ error: libErr.message }, { status: 500 });

  // Print merge order is corporate first, then dealer rows (pdf/generate) —
  // mirror it so the canvas stacks products the way the printed page does.
  type Merged = {
    required: boolean;
    name: string;
    desc: string;
    priceRaw: string;
    separator_above: boolean;
    separator_below: boolean;
    spaces: number;
    conditions: PreviewCondition[];
  };
  const merged: Merged[] = [
    ...corp.map(g => ({
      required: g.required,
      name: g.option_name,
      desc: g.description ?? "",
      priceRaw: g.option_price,
      separator_above: g.separator_above === true,
      separator_below: g.separator_below === true,
      spaces: typeof g.spaces === "number" ? g.spaces : 0,
      conditions: rowConditions(g.applies_to, g.ad_types, (g as unknown as { ad_type?: string | null }).ad_type),
    })),
    ...((libData ?? []) as AddendumLibraryRow[]).map(r => ({
      required: r.required !== false,
      name: r.option_name,
      desc: r.description ?? "",
      priceRaw: r.item_price,
      separator_above: r.separator_above === true,
      separator_below: r.separator_below === true,
      spaces: typeof r.spaces === "number" ? r.spaces : 0,
      conditions: rowConditions(r.applies_to, r.ad_types, r.ad_type),
    })),
  ];

  // Decimals parity with print: the dealer's "Always show cents" toggle
  // (migration 144) forces cents; otherwise the whole-set rule decides.
  const decimals = dealerSettings?.always_show_cents === true
    || priceSetUsesDecimals(merged.map(r => parseOptionPriceValue(r.priceRaw)));
  const split = splitAndMap(
    merged,
    r => r.required,
    r => ({
      name: r.name,
      desc: r.desc,
      price: formatOptionPrice(r.priceRaw, decimals),
      separator_above: r.separator_above,
      separator_below: r.separator_below,
      spaces: r.spaces,
      conditions: r.conditions,
    }),
  );
  return NextResponse.json({ source: "dealer", cap: CAP, ...split });
}
