import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import type { VehiclePreload } from "@/components/builder/types";
import BuilderPage from "@/components/builder/BuilderPage";

export const metadata = { title: "Document Builder — DA Platform" };

function isUUID(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export default async function BuilderVehicleRoute({
  params,
}: {
  params: { vehicleId: string };
}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/builder/${params.vehicleId}`);

  // Only UUID lookups (Supabase dealer_vehicles) are supported
  if (!isUUID(params.vehicleId)) notFound();

  const admin = createAdminSupabaseClient();

  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("id, dealer_id, vin, stock_number, year, make, model, trim, exterior_color, mileage, msrp, condition, vdp_link")
    .eq("id", params.vehicleId)
    .maybeSingle();

  if (!dv) notFound();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  if (profile?.role === "dealer_admin" || profile?.role === "dealer_user") {
    if (profile.dealer_id && dv.dealer_id !== profile.dealer_id) {
      redirect("/dashboard");
    }
  }

  const [{ data: settings }, { data: dealerRow }, { data: customSizeRows }] = await Promise.all([
    admin.from("dealer_settings").select("ai_content_default").eq("dealer_id", dv.dealer_id).single<{ ai_content_default: boolean }>(),
    admin.from("dealers").select("name, address, city, state, zip, phone, logo_url").eq("dealer_id", dv.dealer_id).maybeSingle<{ name: string | null; address: string | null; city: string | null; state: string | null; zip: string | null; phone: string | null; logo_url: string | null }>(),
    admin.from("dealer_custom_sizes").select("id, dealer_id, name, width_in, height_in, background_url, created_at, updated_at").eq("dealer_id", dv.dealer_id).order("name"),
  ]);

  const aiEnabled = settings?.ai_content_default ?? false;

  const S3_LOGO = "https://new-dealer-logos.s3.us-east-1.amazonaws.com/";
  const rawLogo = dealerRow?.logo_url ?? null;
  const resolvedLogoUrl = rawLogo
    ? (rawLogo.startsWith("http") ? rawLogo : S3_LOGO + rawLogo)
    : null;

  const vehicle: VehiclePreload = {
    id: String(dv.id),
    vin: dv.vin ?? "",
    stock_number: dv.stock_number ?? "",
    year: dv.year ?? null,
    make: dv.make ?? null,
    model: dv.model ?? null,
    trim: dv.trim ?? null,
    color_ext: dv.exterior_color ?? null,
    mileage: dv.mileage ?? null,
    msrp: dv.msrp ?? null,
    internet_price: null,
    dealer_id: dv.dealer_id,
    logo_url: resolvedLogoUrl,
    dealer_name: dealerRow?.name ?? null,
    dealer_address: dealerRow?.address ?? null,
    dealer_city: dealerRow?.city ?? null,
    dealer_state: dealerRow?.state ?? null,
    dealer_zip: dealerRow?.zip ?? null,
    dealer_phone: dealerRow?.phone ?? null,
    vdp_link: dv.vdp_link ?? null,
  };

  return <BuilderPage vehicle={vehicle} aiEnabled={aiEnabled} customSizes={customSizeRows ?? []} dealerId={dv.dealer_id} />;
}
