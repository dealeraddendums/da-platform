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

  // Check for active impersonation (super_admin viewing as a dealer)
  const appMeta = session.user.app_metadata as Record<string, unknown>;
  const impersonatingDealerId = (appMeta?.impersonating_dealer_id as string | null) ?? null;

  // Effective dealer context: real dealer role OR impersonating
  const isDealerContext = role === "dealer_admin" || role === "dealer_user" || !!impersonatingDealerId;
  const effectiveDealerId = impersonatingDealerId ?? profile?.dealer_id ?? null;

  // Fetch account_type to determine data source (manual vs Aurora)
  let accountType: string | null = null;
  if (isDealerContext && effectiveDealerId) {
    const { data: dealer } = await admin
      .from("dealers")
      .select("account_type")
      .eq("dealer_id", effectiveDealerId)
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
  } else if (impersonatingDealerId) {
    fixedDealerId = impersonatingDealerId;
  }

  const manual = isDealerContext && isManualDealer(accountType);

  return (
    <div>
      {isDealerContext && <VehicleSubNav />}
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
