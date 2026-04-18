import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import VehicleInventory from "@/components/VehicleInventory";
import ManualVehicleInventory from "@/components/ManualVehicleInventory";
import VehicleSubNav from "@/components/VehicleSubNav";

export const metadata = { title: "Inventory — DA Platform" };

/** Returns true for dealers whose inventory lives in dealer_vehicles (not Aurora). */
function isManualDealer(accountType: string | null): boolean {
  return !accountType || accountType === "Trial" || accountType === "Monthly Subscription Manual";
}

export default async function VehiclesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id, group_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null; group_id: string | null }>();

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  // For dealer roles, fetch account_type to determine data source
  let accountType: string | null = null;
  if ((role === "dealer_admin" || role === "dealer_user") && profile?.dealer_id) {
    const { data: dealer } = await admin
      .from("dealers")
      .select("account_type")
      .eq("dealer_id", profile.dealer_id)
      .single<{ account_type: string | null }>();
    accountType = dealer?.account_type ?? null;
  }

  let fixedDealerId: string | null = null;
  if (role === "dealer_admin" || role === "dealer_user") {
    if (!profile?.dealer_id) {
      return (
        <div>
          <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--text-inverse)" }}>
            Vehicle Inventory
          </h1>
          <div className="card p-6">
            <p style={{ color: "var(--text-secondary)" }}>
              No dealer assigned to your account. Contact your administrator.
            </p>
          </div>
        </div>
      );
    }
    fixedDealerId = profile.dealer_id;
  }

  const manual = (role === "dealer_admin" || role === "dealer_user") && isManualDealer(accountType);

  return (
    <div>
      {(role === "dealer_admin" || role === "dealer_user") && <VehicleSubNav />}
      {manual ? (
        <ManualVehicleInventory dealerId={fixedDealerId!} />
      ) : (
        <VehicleInventory
          fixedDealerId={fixedDealerId}
          role={role}
          groupId={profile?.group_id ?? null}
        />
      )}
    </div>
  );
}
