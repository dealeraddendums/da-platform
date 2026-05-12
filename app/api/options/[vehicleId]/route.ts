import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { createAdminSupabaseClient } from "@/lib/db";
import { getGroupOptionsForDealer } from "@/lib/options-engine";
import { syncAddendumItems } from "@/lib/sync-addendum-items";
import type { VehicleOptionRow } from "@/lib/db";

type Params = { params: { vehicleId: string } };

function isUUID(v: string) { return v.includes("-"); }
function isManual(v: string) { return isUUID(v) || v === "0"; }

/**
 * Mirror the current per-vehicle option set into vehicle_addendum_items.
 * Resolves the dealer's UUID and the vehicle's vin from Supabase first
 * because the save path only has the text dealer_id and the vehicle UUID.
 * Fire-and-forget at the call site so a sync failure never blocks a save.
 */
async function mirrorToAddendumItems(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  vehicleId: string,
  dealerTextId: string,
  options: Array<{ option_name: string; option_price?: string }>,
): Promise<void> {
  try {
    if (!isUUID(vehicleId)) return; // legacy "0" sentinel — no real vehicle row
    const [dealerRes, vehicleRes] = await Promise.all([
      admin.from("dealers").select("id").eq("dealer_id", dealerTextId).maybeSingle<{ id: string }>(),
      admin.from("dealer_vehicles").select("vin").eq("id", vehicleId).maybeSingle<{ vin: string | null }>(),
    ]);
    await syncAddendumItems(admin, {
      vehicleId,
      dealerId: dealerRes.data?.id ?? null,
      vin: vehicleRes.data?.vin ?? null,
      products: options.map(o => ({ name: o.option_name, price: o.option_price })),
    });
  } catch (err) {
    console.error("[options POST] addendum-items sync failed:", err instanceof Error ? err.message : err);
  }
}

// Build a map of option_name → false for any addendum_library entries marked required=false.
// Used to override stale vehicle_options.required=true values when the library flag changed.
async function buildLibRequiredMap(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  dealerId: string,
  optionNames: string[]
): Promise<Record<string, boolean>> {
  if (optionNames.length === 0) return {};
  const { data } = await admin
    .from("addendum_library")
    .select("option_name, required")
    .eq("dealer_id", dealerId)
    .in("option_name", optionNames);
  const map: Record<string, boolean> = {};
  for (const r of data ?? []) {
    if (r.required === false) map[r.option_name as string] = false;
  }
  return map;
}

function applyLibRequired<T extends { option_name: string; required?: boolean | null }>(
  rows: T[],
  libMap: Record<string, boolean>
): T[] {
  return rows.map(r => {
    if (libMap[r.option_name] === false) return { ...r, required: false };
    return r;
  });
}

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
        const libMap = await buildLibRequiredMap(admin, effectiveDealerId, saved.map(r => r.option_name as string));
        return NextResponse.json({ data: applyLibRequired(saved, libMap), groupOptions, source: "saved" });
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
          const libMap = await buildLibRequiredMap(admin, effectiveDealerId, legacySaved.map(r => r.option_name as string));
          return NextResponse.json({ data: applyLibRequired(legacySaved, libMap), groupOptions, source: "saved" });
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
      const libMap = await buildLibRequiredMap(admin, effectiveDealerId, saved.map(r => r.option_name as string));
      return NextResponse.json({ data: applyLibRequired(saved, libMap), groupOptions, source: "saved" });
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
      // Mirror to vehicle_addendum_items (reporting table). Fire-and-forget;
      // a failure here must not break the save.
      void mirrorToAddendumItems(admin, vid, effectiveDealerId, body.options);
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

    void mirrorToAddendumItems(admin, vid, effectiveDealerId, body.options);
    return NextResponse.json({ data });

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[options POST]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
