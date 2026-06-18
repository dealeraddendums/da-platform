import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { resolveSessionProfile } from "@/lib/profile-session";
import type { VehicleRow } from "@/lib/vehicles";
import AddendumEditor from "@/components/AddendumEditor";

export const metadata = { title: "Addendum — DA Platform" };

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export default async function AddendumPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { type?: string };
}) {
  // ?type=infosheet|buyer_guide (from the Bulk buttons) → open that doc type.
  const rawType = searchParams?.type;
  const initialDocType: "infosheet" | "buyer_guide" | undefined =
    rawType === "infosheet" || rawType === "buyer_guide" ? rawType : undefined;

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/vehicles/${params.id}/addendum`);

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null }>(admin, session, "role, dealer_id");

  const role = profile?.role ?? "dealer_user";
  const isDealer = role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted";

  let vehicle: VehicleRow;
  let dealerVehicleId: string;

  // Only UUID lookups (Supabase dealer_vehicles) are supported
  if (!isUUID(params.id)) notFound();

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
    FUEL: dv.fuel ?? null,
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
    HMPG: dv.hmpg ?? null,
    CMPG: dv.cmpg ?? null,
    MPG: dv.mpg ?? null,
  };

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

      <AddendumEditor
        vehicle={vehicle}
        dealerVehicleId={dealerVehicleId}
        initialDocType={initialDocType}
        initialPrintState={{
          addendum: dv.print_status === 1,
          infosheet: dv.print_info === 1,
          buyer_guide: dv.print_guide === 1,
          lastDate: dv.print_date ?? null,
        }}
      />
    </div>
  );
}
