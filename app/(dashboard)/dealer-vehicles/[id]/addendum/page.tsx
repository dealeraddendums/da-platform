import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import AddendumEditor from "@/components/AddendumEditor";
import type { VehicleRow } from "@/lib/vehicles";

export const metadata = { title: "Addendum — DA Platform" };

export default async function DealerVehicleAddendumPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/dealer-vehicles/${params.id}/addendum`);

  const admin = createAdminSupabaseClient();

  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  // Only dealer roles can access manual vehicles
  if (profile?.role === "super_admin" || profile?.role === "group_admin") {
    redirect("/dashboard");
  }

  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!dv) notFound();

  // Scope check
  if (profile?.dealer_id && dv.dealer_id !== profile.dealer_id) {
    redirect("/vehicles");
  }

  // Map dealer_vehicles row → VehicleRow shape for AddendumEditor
  // id=0 is used as a sentinel — options engine will return empty for this vehicle
  const vehicle: VehicleRow = {
    id: 0,
    DEALER_ID: dv.dealer_id,
    VIN_NUMBER: dv.vin ?? "",
    STOCK_NUMBER: dv.stock_number,
    YEAR: dv.year ? String(dv.year) : null,
    MAKE: dv.make,
    MODEL: dv.model,
    BODYSTYLE: dv.body_style,
    TRIM: dv.trim,
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
    DESCRIPTION: null,
    PRINT_STATUS: "0",
    HMPG: null,
    CMPG: null,
    MPG: null,
  };

  const vehicleName = [dv.year, dv.make, dv.model].filter(Boolean).join(" ");

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <a href="/vehicles" className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>Inventory</a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{vehicleName || dv.stock_number}</span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "var(--text-inverse)" }}>Addendum</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          {[dv.year, dv.make, dv.model, dv.trim].filter(Boolean).join(" ") || dv.stock_number}
        </h1>
        {dv.vin && (
          <p className="text-sm mt-0.5 font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>{dv.vin}</p>
        )}
        <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.4)" }}>
          Manual vehicle entry — stock #{dv.stock_number}
        </p>
      </div>

      <AddendumEditor vehicle={vehicle} />
    </div>
  );
}
