import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/aurora";
import type { VehicleRowPacket } from "@/lib/aurora";
import type { PrintHistoryRow } from "@/lib/db";

export const metadata = { title: "Print History — DA Platform" };

function docLabel(t: string) {
  return t === "addendum" ? "Addendum" : t === "infosheet" ? "Info Sheet" : "Buyer Guide";
}

export default async function HistoryPage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    redirect(`/login?next=/vehicles/${params.id}/history`);
  }

  const vehicleId = parseInt(params.id, 10);
  if (isNaN(vehicleId)) notFound();

  const pool = getPool();
  const [rows] = await pool.execute<VehicleRowPacket[]>(
    "SELECT id, DEALER_ID, YEAR, MAKE, MODEL, TRIM, VIN_NUMBER FROM dealer_inventory WHERE id = ? LIMIT 1",
    [vehicleId]
  );
  if (!rows.length) notFound();

  const v = rows[0];

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

  const { data: history } = await admin
    .from("print_history")
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order("created_at", { ascending: false });

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <a href="/vehicles" className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>Inventory</a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <a href={`/vehicles/${vehicleId}/addendum`} className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
            {[v.YEAR, v.MAKE, v.MODEL].filter(Boolean).join(" ")}
          </a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "var(--text-inverse)" }}>Print History</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Print History</h1>
        <p className="text-sm mt-0.5 font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>{v.VIN_NUMBER}</p>
      </div>

      <div className="card overflow-hidden">
        {!history || history.length === 0 ? (
          <div className="p-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            No print history for this vehicle.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                {["Document Type", "Date Printed"].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(history as PrintHistoryRow[]).map((row, i) => (
                <tr
                  key={row.id}
                  style={{ borderBottom: i < history.length - 1 ? "1px solid var(--border)" : "none" }}
                >
                  <td className="px-4 py-3">
                    <DocBadge type={row.document_type} />
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)" }}>
                    {new Date(row.created_at).toLocaleString("en-US", {
                      month: "short", day: "numeric", year: "numeric",
                      hour: "numeric", minute: "2-digit",
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DocBadge({ type }: { type: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    addendum:   { bg: "#e3f2fd", color: "#1565c0" },
    infosheet:  { bg: "#e8f5e9", color: "#2e7d32" },
    buyer_guide: { bg: "#fff8e1", color: "#e65100" },
  };
  const s = styles[type] ?? { bg: "var(--bg-subtle)", color: "var(--text-secondary)" };
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color }}
    >
      {docLabel(type)}
    </span>
  );
}
