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
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/builder/${params.vehicleId}`);

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  if (profile?.role === "dealer_admin" || profile?.role === "dealer_user") {
    if (profile.dealer_id && r.DEALER_ID !== profile.dealer_id) {
      redirect("/dashboard");
    }
  }

  const admin = createAdminSupabaseClient();
  const [{ data: settings }, { data: dealerRow }, { data: customSizeRows }, { data: dvRow }] = await Promise.all([
    admin.from("dealer_settings").select("ai_content_default").eq("dealer_id", r.DEALER_ID).single<{ ai_content_default: boolean }>(),
    admin.from("dealers").select("name, address, city, state, zip, phone, logo_url").eq("dealer_id", r.DEALER_ID).maybeSingle<{ name: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; logo_url: string | null }>(),
    admin.from("dealer_custom_sizes").select("id, dealer_id, name, width_in, height_in, background_url, created_at, updated_at").eq("dealer_id", r.DEALER_ID).order("name"),
    admin.from("dealer_vehicles").select("vdp_link").eq("id", params.vehicleId).maybeSingle<{ vdp_link: string | null }>(),
  ]);

  const aiEnabled = settings?.ai_content_default ?? false;

  const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
  const rawLogo = dealerRow?.logo_url ?? (r as Record<string, unknown>).logo_url as string | null ?? null;
  const resolvedLogoUrl = rawLogo
    ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo)
    : null;

  // Supabase dealers table is the canonical source — matches what the PDF route uses.
  // Fall back to Aurora dealer_dim fields if Supabase has no record yet.
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
    logo_url: resolvedLogoUrl,
    dealer_name: dealerRow?.name ?? (r as Record<string, unknown>).DEALER_NAME as string | null ?? null,
    dealer_address: dealerRow?.address ?? (r as Record<string, unknown>).DEALER_ADDRESS as string | null ?? null,
    dealer_city: dealerRow?.city ?? (r as Record<string, unknown>).DEALER_CITY as string | null ?? null,
    dealer_state: dealerRow?.state ?? (r as Record<string, unknown>).DEALER_STATE as string | null ?? null,
    dealer_zip: dealerRow?.zip ?? (r as Record<string, unknown>).DEALER_ZIP as string | null ?? null,
    dealer_phone: dealerRow?.phone ?? (r as Record<string, unknown>).DEALER_PHONE as string | null ?? null,
    vdp_link: dvRow?.vdp_link ?? null,
  };

  return <BuilderPage vehicle={vehicle} aiEnabled={aiEnabled} customSizes={customSizeRows ?? []} dealerId={r.DEALER_ID} />;
}
