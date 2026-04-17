import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ProfileRow } from "@/lib/db";
import VehicleInventory from "@/components/VehicleInventory";

export const metadata = { title: "Inventory — DA Platform" };

export default async function VehiclesPage() {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) redirect("/login");

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .returns<ProfileRow[]>()
    .single();

  const profile = data as ProfileRow | null;
  const role = profile?.role ?? "dealer_user";

  // dealer_admin / dealer_user: fixed to their own dealer
  // super_admin / group_admin: must pick a dealer (null = show picker)
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

  return (
    <VehicleInventory
      fixedDealerId={fixedDealerId}
      role={role}
      groupId={profile?.group_id ?? null}
    />
  );
}
