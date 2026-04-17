import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import AddendumEditor from "@/components/AddendumEditor";

export const metadata = { title: "Addendum Options — DA Platform" };

export default async function AddendumPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect(`/login?next=/vehicles/${params.id}/addendum`);
  }

  const vehicleId = parseInt(params.id, 10);
  if (isNaN(vehicleId)) notFound();

  const pool = getPool();
  const [rows] = await pool.execute<VehicleRowPacket[]>(
    `SELECT id, DEALER_ID, VIN_NUMBER, STOCK_NUMBER, YEAR, MAKE, MODEL,
            TRIM, BODYSTYLE, EXT_COLOR, MILEAGE, MSRP, NEW_USED, CERTIFIED,
            PHOTOS, PRINT_STATUS, DATE_IN_STOCK
     FROM dealer_inventory WHERE id = ? LIMIT 1`,
    [vehicleId]
  );
  if (!rows.length) notFound();

  const v = rows[0];

  // Scope check: dealer roles can only view their own dealer's vehicles
  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  if (profile?.role === "dealer_admin" || profile?.role === "dealer_user") {
    if (profile.dealer_id && v.DEALER_ID !== profile.dealer_id) {
      redirect("/vehicles");
    }
  }

  return (
    <div>
      {/* Sub-header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <a
            href="/vehicles"
            className="text-sm"
            style={{ color: "rgba(255,255,255,0.6)" }}
          >
            Inventory
          </a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            {[v.YEAR, v.MAKE, v.MODEL].filter(Boolean).join(" ")}
          </span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "var(--text-inverse)" }}>Addendum</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          {[v.YEAR, v.MAKE, v.MODEL, v.TRIM].filter(Boolean).join(" ")}
        </h1>
        {v.VIN_NUMBER && (
          <p className="text-sm mt-0.5 font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>
            {v.VIN_NUMBER}
          </p>
        )}
      </div>

      <AddendumEditor vehicle={v} />
    </div>
  );
}
