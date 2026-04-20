import { redirect, notFound } from "next/navigation";
import { createClient, createAdminSupabaseClient } from "@/lib/supabase/server";
import type { AddendumHistoryRow } from "@/lib/db";

export const metadata = { title: "Print History — DA Platform" };

type PageProps = { params: { id: string }; searchParams: { page?: string } };

const PAGE_SIZE = 25;

export default async function HistoryPage({ params, searchParams }: PageProps) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect(`/login?next=/vehicles/${params.id}/history`);

  const admin = createAdminSupabaseClient();
  const page = Math.max(1, parseInt(searchParams.page ?? "1", 10));

  const { data: dv } = await admin
    .from("dealer_vehicles")
    .select("id, dealer_id, year, make, model, trim, vin, stock_number")
    .eq("id", params.id)
    .maybeSingle();

  if (!dv) notFound();

  const { data: profile } = await admin
    .from("profiles")
    .select("role, dealer_id")
    .eq("id", session.user.id)
    .single<{ role: string; dealer_id: string | null }>();

  if (profile?.role === "dealer_admin" || profile?.role === "dealer_user") {
    if (profile.dealer_id && dv.dealer_id !== profile.dealer_id) redirect("/vehicles");
  }

  const vehicleName = [dv.year, dv.make, dv.model].filter(Boolean).join(" ");

  // Query addendum_history by VIN (stable across systems)
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const { data: history, count } = await admin
    .from("addendum_history")
    .select("*", { count: "exact" })
    .eq("vin", dv.vin ?? "")
    .order("creation_date", { ascending: false })
    .order("order_by", { ascending: true })
    .range(from, to);

  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <a href="/vehicles" className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>Inventory</a>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>{vehicleName}</span>
          <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>›</span>
          <span className="text-sm" style={{ color: "var(--text-inverse)" }}>Print History</span>
        </div>
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>Print History</h1>
        <p className="text-sm mt-0.5 font-mono" style={{ color: "rgba(255,255,255,0.6)" }}>{dv.vin}</p>
        {count != null && count > 0 && (
          <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.5)" }}>
            {count.toLocaleString()} option{count !== 1 ? "s" : ""} applied
          </p>
        )}
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
                {["Date", "Option Applied", "Price", "Source"].map((h) => (
                  <th key={h} className="text-left px-4 py-2.5 font-semibold"
                    style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(history as AddendumHistoryRow[]).map((row, i) => (
                <tr key={row.id}
                  style={{ borderBottom: i < history.length - 1 ? "1px solid var(--border)" : "none" }}>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    {row.creation_date
                      ? new Date(row.creation_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>{row.item_name}</span>
                    {row.item_description && (
                      <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{row.item_description}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs" style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {row.item_price && row.item_price !== "NC" && row.item_price !== "" ? row.item_price : "NC"}
                  </td>
                  <td className="px-4 py-3">
                    <SourceBadge source={row.source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3" style={{ borderTop: "1px solid var(--border)" }}>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              Page {page} of {totalPages} · {count?.toLocaleString()} total
            </span>
            <div className="flex gap-2">
              {page > 1 && (
                <a href={`?page=${page - 1}`}
                  className="text-xs px-3 py-1 rounded"
                  style={{ border: "1px solid var(--border)", color: "var(--text-secondary)", background: "white" }}>
                  ← Prev
                </a>
              )}
              {page < totalPages && (
                <a href={`?page=${page + 1}`}
                  className="text-xs px-3 py-1 rounded"
                  style={{ border: "1px solid var(--border)", color: "var(--text-secondary)", background: "white" }}>
                  Next →
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: string | null }) {
  const isPlatform = source === "platform";
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{
        background: isPlatform ? "#e3f2fd" : "#f5f6f7",
        color: isPlatform ? "#1565c0" : "#55595c",
      }}>
      {isPlatform ? "Platform" : "Legacy"}
    </span>
  );
}
