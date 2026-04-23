import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import type { VehicleRow } from "@/lib/vehicles";
import AddendumEditor from "@/components/AddendumEditor";

export const metadata = { title: "Addendum — DA Platform" };

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export default async function AddendumPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/vehicles/${params.id}/addendum`);

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  const role = profile?.role ?? "dealer_user";
  const isDealer = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";

  let vehicle: VehicleRow;
  let dealerVehicleId: string;

  if (isUUID(params.id)) {
    // ── Supabase manual vehicle ───────────────────────────────────────────────
    const { data: dv } = await admin
      .from("dealer_vehicles")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();

    if (!dv) notFound();

    if (isDealer && profile?.dealer_id && dv.dealer_id !== profile.dealer_id) {
      redirect("/dashboard");
    }

    dealerVehicleId = dv.id as string;
    vehicle = {
      id: 0,
      DEALER_ID: dv.dealer_id,
      VIN_NUMBER: dv.vin ?? "",
      STOCK_NUMBER: dv.stock_number,
      YEAR: dv.year ? String(dv.year) : null,
      MAKE: dv.make,
      MODEL: dv.model,
      TRIM: dv.trim,
      BODYSTYLE: dv.body_style ?? null,
      EXT_COLOR: dv.exterior_color ?? null,
      INT_COLOR: dv.interior_color ?? null,
      ENGINE: dv.engine ?? null,
      FUEL: null,
      DRIVETRAIN: dv.drivetrain ?? null,
      TRANSMISSION: dv.transmission ?? null,
      MILEAGE: dv.mileage ? String(dv.mileage) : null,
      DATE_IN_STOCK: dv.date_added ?? null,
      STATUS: "1",
      MSRP: dv.msrp ? String(dv.msrp) : null,
      NEW_USED: dv.condition === "Used" ? "Used" : "New",
      CERTIFIED: dv.condition === "CPO" ? "Yes" : "No",
      OPTIONS: null,
      PHOTOS: null,
      DESCRIPTION: dv.description ?? null,
      PRINT_STATUS: "0",
      HMPG: null,
      CMPG: null,
      MPG: null,
    };
  } else {
    // ── Aurora legacy vehicle ─────────────────────────────────────────────────
    const pool = getPool();
    const [rows] = await pool.execute<VehicleRowPacket[]>(
      `SELECT v.* FROM dealer_inventory v WHERE v.id = ? AND v.STATUS = 1 LIMIT 1`,
      [params.id]
    );

    if (!rows.length) notFound();
    const r = rows[0];

    if (isDealer && profile?.dealer_id && r.DEALER_ID !== profile.dealer_id) {
      redirect("/dashboard");
    }

    // Try to find a matching dealer_vehicles record by VIN for PDF generation
    const { data: dvMatch } = r.VIN_NUMBER
      ? await admin
          .from("dealer_vehicles")
          .select("id")
          .eq("vin", r.VIN_NUMBER)
          .eq("dealer_id", r.DEALER_ID)
          .maybeSingle()
      : { data: null };

    dealerVehicleId = dvMatch?.id ?? "";

    vehicle = {
      id: r.id,
      DEALER_ID: r.DEALER_ID,
      VIN_NUMBER: r.VIN_NUMBER,
      STOCK_NUMBER: r.STOCK_NUMBER,
      YEAR: r.YEAR,
      MAKE: r.MAKE,
      MODEL: r.MODEL,
      TRIM: r.TRIM,
      BODYSTYLE: r.BODYSTYLE,
      EXT_COLOR: r.EXT_COLOR,
      INT_COLOR: r.INT_COLOR,
      ENGINE: r.ENGINE,
      FUEL: r.FUEL,
      DRIVETRAIN: r.DRIVETRAIN,
      TRANSMISSION: r.TRANSMISSION,
      MILEAGE: r.MILEAGE,
      DATE_IN_STOCK: r.DATE_IN_STOCK,
      STATUS: r.STATUS ?? "1",
      MSRP: r.MSRP,
      NEW_USED: r.NEW_USED ?? "New",
      CERTIFIED: r.CERTIFIED ?? "No",
      OPTIONS: r.OPTIONS,
      PHOTOS: r.PHOTOS,
      DESCRIPTION: r.DESCRIPTION ?? null,
      PRINT_STATUS: r.PRINT_STATUS ?? "0",
      HMPG: r.HMPG ?? null,
      CMPG: r.CMPG ?? null,
      MPG: r.MPG ?? null,
    };
  }

  const vehicleName = [vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ");

  return (
    <div>
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <a href="/dashboard" className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            Inventory
          </a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "var(--text-inverse)" }}>Addendum</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          {vehicleName || "Vehicle"}
        </h1>
        {vehicle.VIN_NUMBER && (
          <p className="text-sm mt-0.5 font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>
            {vehicle.VIN_NUMBER}
          </p>
        )}
      </div>

      <AddendumEditor vehicle={vehicle} dealerVehicleId={dealerVehicleId} />
    </div>
  );
}
