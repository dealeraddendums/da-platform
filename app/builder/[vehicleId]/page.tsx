import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import type { VehiclePreload } from "@/components/builder/types";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

export default async function BuilderVehicleRoute({
  params,
}: {
  params: { vehicleId: string };
}) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect(`/login?next=/builder/${params.vehicleId}`);
  }

  // Fetch vehicle from Aurora
  const pool = getPool();
  const [rows] = await pool.execute<VehicleRowPacket[]>(
    `SELECT v.id, v.DEALER_ID, v.VIN_NUMBER, v.STOCK_NUMBER, v.YEAR, v.MAKE,
            v.MODEL, v.TRIM, v.EXT_COLOR, v.MILEAGE, v.MSRP, v.NEW_USED, v.CERTIFIED,
            d.DEALER_NAME, d.DEALER_ADDRESS, d.DEALER_CITY, d.DEALER_STATE,
            d.DEALER_ZIP, d.DEALER_PHONE, d.logo_url
     FROM dealer_inventory v
     LEFT JOIN dealer_dim d ON d.DEALER_ID = v.DEALER_ID
     WHERE v.id = ? LIMIT 1`,
    [params.vehicleId]
  );

  if (!rows.length) notFound();

  const r = rows[0];

  // Fetch profile to check dealer scope
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  // Scope check: dealer_admin/user can only open their own dealer's vehicles
  // TODO: verify this should use inventory_dealer_id (profile.dealer_id is Supabase; r.DEALER_ID is Aurora)
  if (
    profile?.role === "dealer_admin" ||
    profile?.role === "dealer_user"
  ) {
    if (profile.dealer_id && r.DEALER_ID !== profile.dealer_id) {
      redirect("/vehicles");
    }
  }

  const vehicle: VehiclePreload = {
    id: String(r.id),
    vin: r.VIN_NUMBER,
    stock_number: r.STOCK_NUMBER ?? "",
    year: r.YEAR ? Number(r.YEAR) : null,
    make: r.MAKE,
    model: r.MODEL,
    trim: r.TRIM,
    color_ext: r.EXT_COLOR,
    mileage: r.MILEAGE ? Number(r.MILEAGE) : null,
    msrp: r.MSRP ? Number(r.MSRP) : null,
    internet_price: null,
    dealer_id: r.DEALER_ID,
    logo_url: (r as Record<string, unknown>).logo_url as string | null ?? null,
    dealer_name: (r as Record<string, unknown>).DEALER_NAME as string | null ?? null,
    dealer_address: [
      (r as Record<string, unknown>).DEALER_ADDRESS,
      (r as Record<string, unknown>).DEALER_CITY,
      (r as Record<string, unknown>).DEALER_STATE,
      (r as Record<string, unknown>).DEALER_ZIP,
    ]
      .filter(Boolean)
      .join(", ") || null,
  };

  // Fetch dealer's AI content default setting
  const admin = createAdminSupabaseClient();
  const { data: settings } = await admin
    .from("dealer_settings")
    .select("ai_content_default")
    .eq("dealer_id", r.DEALER_ID)
    .single<{ ai_content_default: boolean }>();

  const aiEnabled = settings?.ai_content_default ?? false;

  return <BuilderPage vehicle={vehicle} aiEnabled={aiEnabled} />;
}
