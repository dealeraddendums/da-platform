import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { verifyGhostToken } from "@/lib/ghost";
import ManualVehicleInventory from "@/components/ManualVehicleInventory";
import VehicleSubNav from "@/components/VehicleSubNav";
import { canPrintForDealer } from "@/lib/print-eligibility";

export const metadata = { title: "Inventory — DA Platform" };

export default async function VehiclesPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string; dealer_id: string | null; group_id: string | null }>(admin, session, "role, dealer_id, group_id");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  // Dealer roles use /dashboard as their inventory view
  if (role === "dealer_admin" || role === "dealer_user" || role === "dealer_restricted") {
    redirect("/dashboard");
  }

  // Check for active impersonation (super_admin viewing as a dealer)
  const appMeta = session.user.app_metadata as Record<string, unknown>;
  const impersonatingDealerId = (appMeta?.impersonating_dealer_id as string | null) ?? null;

  // Check for ghost mode
  const cookieStore = cookies();
  const ghostCtx = role === "super_admin"
    ? verifyGhostToken(cookieStore.get("da_ghost_token")?.value ?? "")
    : null;
  const ghostDealerId = ghostCtx?.dealer_text_id ?? null;

  // Effective dealer context: real dealer role OR impersonating OR ghost mode
  const isDealerContext = role === "dealer_admin" || role === "dealer_user" || !!impersonatingDealerId || !!ghostDealerId;

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
  } else if (ghostDealerId) {
    fixedDealerId = ghostDealerId;
  }

  // super_admin or group_admin without a dealer context — show prompt to select a dealer
  if (!fixedDealerId) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--text-inverse)" }}>
          Vehicle Inventory
        </h1>
        <div className="card p-6">
          <p style={{ color: "var(--text-secondary)" }}>
            Select a dealer to view their vehicle inventory. Use the dealer switcher or impersonation flow.
          </p>
        </div>
      </div>
    );
  }

  // super_admin bypasses the print gate (enforceCanPrint short-circuits
  // on role==='super_admin'). For everyone else, resolve the gate
  // server-side so the buttons render in the correct state on first
  // paint (avoids the click-then-403 round-trip).
  const printGate = role === "super_admin" ? undefined : await canPrintForDealer(fixedDealerId);

  return (
    <div>
      {isDealerContext && <VehicleSubNav />}
      <ManualVehicleInventory dealerId={fixedDealerId} isSuperAdmin={role === "super_admin"} printGate={printGate} />
    </div>
  );
}
