import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function isUUID(v: string) { return v.includes("-"); }
function isManual(v: string) { return isUUID(v) || v === "0"; }

/**
 * GET /api/options/[vehicleId]
 * vehicleId can be:
 *   - UUID string: dealer_vehicle (dealer_vehicles.id)
 *   - "0":         legacy sentinel (backward compat, treated as manual)
 * Legacy integer vehicle IDs are not supported — use UUID from dealer_vehicles.
 */
export async function GET(
  _req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    const admin = createAdminSupabaseClient();
    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;

    // ── Manual vehicle path (UUID or legacy '0') ─────────────────────────────
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ data: [], groupOptions: [], source: "empty" });
      }

      const groupOptions = await getGroupOptionsForDealer(effectiveDealerId);

      // Check for saved options keyed by this vehicleId
      const { data: saved } = await admin
        .from("vehicle_options")
        .select("*")
        .eq("vehicle_id", vid)
        .eq("dealer_id", effectiveDealerId)
        .order("sort_order", { ascending: true });

      if (saved && saved.length > 0) {
        return NextResponse.json({ data: saved, groupOptions, source: "saved" });
      }

      // If UUID and nothing found, also check legacy '0' sentinel as fallback
      if (isUUID(vid)) {
        const { data: legacySaved } = await admin
          .from("vehicle_options")
          .select("*")
          .eq("vehicle_id", "0")
          .eq("dealer_id", effectiveDealerId)
          .order("sort_order", { ascending: true });

        if (legacySaved && legacySaved.length > 0) {
          return NextResponse.json({ data: legacySaved, groupOptions, source: "saved" });
        }
      }

      // No saved options — seed from dealer's addendum_library
      const { data: library } = await admin
        .from("addendum_library")
        .select("*")
        .eq("dealer_id", effectiveDealerId)
        .eq("active", true)
        .neq("applies_to", "none")
        .order("sort_order", { ascending: true });

      const matched = (library ?? []).map((r, i) => ({
        default_id: r.id,
        option_name: r.option_name,
        option_price: r.item_price ?? "NC",
        description: r.description ?? null,
        sort_order: r.sort_order ?? i,
        source: "default" as const,
        required: (r.required ?? true) as boolean,
      }));

      return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });
    }

    // ── Non-UUID, non-"0" vehicleId: not supported ──────────────────────────────
    // Fall back to dealer context from JWT — return empty options
    if (!effectiveDealerId) {
      return NextResponse.json({ data: [], groupOptions: [], source: "empty" });
    }

    const groupOptions = await getGroupOptionsForDealer(effectiveDealerId);

    // Check for saved options keyed by this vehicleId
    const { data: saved } = await admin
      .from("vehicle_options")
      .select("*")
      .eq("vehicle_id", vid)
      .eq("dealer_id", effectiveDealerId)
      .order("sort_order", { ascending: true });

    if (saved && saved.length > 0) {
      return NextResponse.json({ data: saved, groupOptions, source: "saved" });
    }

    // No saved options — seed from dealer's addendum_library
    const { data: library } = await admin
      .from("addendum_library")
      .select("*")
      .eq("dealer_id", effectiveDealerId)
      .eq("active", true)
      .neq("applies_to", "none")
      .order("sort_order", { ascending: true });

    const matched = (library ?? []).map((r, i) => ({
      default_id: r.id,
      option_name: r.option_name,
      option_price: r.item_price ?? "NC",
      description: r.description ?? null,
      sort_order: r.sort_order ?? i,
      source: "default" as const,
      required: (r.required ?? true) as boolean,
    }));

    return NextResponse.json({ data: matched, groupOptions, source: "matched", saved: false });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options GET]", msg);
    return NextResponse.json({ error: msg, data: [], groupOptions: [] }, { status: 500 });
  }
}

/**
 * POST /api/options/[vehicleId]
 * Replaces all options for a vehicle (batch save).
 */
export async function POST(
  req: NextRequest,
  { params }: Params
): Promise<NextResponse> {
  try {
    const { claims, error } = await requireAuth();
    if (error) return error;

    const vid = params.vehicleId;
    type OptionInput = Pick<VehicleOptionRow, "option_name" | "option_price" | "sort_order" | "source"> & { description?: string | null; required?: boolean };
    const body = await req.json() as { options?: OptionInput[]; dealer_id?: string };
    if (!body.options || !Array.isArray(body.options)) {
      return NextResponse.json({ error: "options array required" }, { status: 400 });
    }

    const effectiveDealerId = claims.impersonating_dealer_id ?? claims.dealer_id;
    const admin = createAdminSupabaseClient();

    // Manual vehicle path (UUID or legacy '0')
    if (isManual(vid)) {
      if (!effectiveDealerId) {
        return NextResponse.json({ error: "No dealer context" }, { status: 403 });
      }
      await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", effectiveDealerId);
      // Also clear legacy '0' sentinel if saving under UUID (migrate on write)
      if (isUUID(vid)) {
        await admin.from("vehicle_options").delete().eq("vehicle_id", "0").eq("dealer_id", effectiveDealerId);
      }
      const inserts = body.options.map((o, i) => ({
        vehicle_id: vid,
        dealer_id: effectiveDealerId,
        option_name: o.option_name,
        option_price: o.option_price ?? "NC",
        description: o.description ?? null,
        sort_order: o.sort_order ?? i,
        source: o.source ?? "manual",
        required: o.required !== false,
      }));
      const { data, error: insertErr } = await admin.from("vehicle_options").insert(inserts).select("*");
      if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
      return NextResponse.json({ data });
    }

    // Non-UUID, non-"0" vehicleId: use dealer context from JWT
    if (!effectiveDealerId) {
      return NextResponse.json({ error: "No dealer context" }, { status: 403 });
    }

    await admin.from("vehicle_options").delete().eq("vehicle_id", vid).eq("dealer_id", effectiveDealerId);

    const inserts = body.options.map((o, i) => ({
      vehicle_id: vid,
      dealer_id: effectiveDealerId,
      option_name: o.option_name,
      option_price: o.option_price ?? "NC",
      description: o.description ?? null,
      sort_order: o.sort_order ?? i,
      source: o.source ?? "manual",
      required: o.required !== false,
    }));

    const { data, error: insertErr } = await admin
      .from("vehicle_options")
      .insert(inserts)
      .select("*");

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    return NextResponse.json({ data });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options POST]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
