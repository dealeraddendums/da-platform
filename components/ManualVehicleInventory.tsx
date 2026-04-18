"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import AddVehicleModal from "./AddVehicleModal";
import type { DealerVehicleRow } from "@/lib/db";

type Props = {
  dealerId: string;
};

type ListResponse = {
  data: DealerVehicleRow[];
  total: number;
  page: number;
  per_page: number;
};

const PER_PAGE = 50;

const SOURCE_LABELS: Record<string, string> = {
  nhtsa: "NHTSA",
  override: "Override",
  dealer_vehicles: "Prior entry",
  aurora: "Legacy DB",
  partial: "Partial",
  manual: "Manual",
};

function conditionBadge(c: string) {
  const styles: Record<string, React.CSSProperties> = {
    New: { background: "#e3f2fd", color: "#1565c0", border: "1px solid #bbdefb" },
    Used: { background: "#f3e5f5", color: "#6a1b9a", border: "1px solid #e1bee7" },
    CPO: { background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" },
  };
  const s = styles[c] ?? { background: "#f5f6f7", color: "#555", border: "1px solid #e0e0e0" };
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 20, whiteSpace: "nowrap" as const, ...s }}>
      {c}
    </span>
  );
}

function fmt(v: number | null) {
  if (!v) return "—";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

export default function ManualVehicleInventory({ dealerId }: Props) {
  const [vehicles, setVehicles] = useState<DealerVehicleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [condition, setCondition] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchVehicles = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      condition,
    });
    if (q) params.set("q", q);

    const res = await fetch(`/api/dealer-vehicles?${params}`);
    const json = await res.json() as ListResponse & { error?: string };
    setLoading(false);
    if (!res.ok) {
      setError(json.error ?? "Failed to load vehicles");
    } else {
      setVehicles(json.data);
      setTotal(json.total);
    }
  }, [page, condition, q]);

  useEffect(() => { fetchVehicles(); }, [fetchVehicles]);

  const totalPages = Math.ceil(total / PER_PAGE);

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <form
          onSubmit={(e) => { e.preventDefault(); setQ(searchInput); setPage(1); }}
          style={{ display: "flex", gap: 6 }}
        >
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search stock, VIN, make, model…"
            style={{ height: 36, border: "1px solid var(--border)", borderRadius: 4, padding: "0 10px", fontSize: 13, width: 240 }}
          />
          <button type="submit" style={{ height: 36, padding: "0 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, cursor: "pointer" }}>
            Search
          </button>
          {q && (
            <button type="button" onClick={() => { setQ(""); setSearchInput(""); setPage(1); }}
              style={{ height: 36, padding: "0 10px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-muted)" }}>
              Clear
            </button>
          )}
        </form>

        <select
          value={condition}
          onChange={(e) => { setCondition(e.target.value); setPage(1); }}
          style={{ height: 36, border: "1px solid var(--border)", borderRadius: 4, padding: "0 8px", fontSize: 13 }}
        >
          <option value="all">All Conditions</option>
          <option value="New">New</option>
          <option value="Used">Used</option>
          <option value="CPO">CPO</option>
        </select>

        <div style={{ marginLeft: "auto" }}>
          <AddVehicleModal dealerId={dealerId} onSaved={() => fetchVehicles()} />
        </div>
      </div>

      {/* Summary */}
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginBottom: 10 }}>
        {total.toLocaleString()} vehicle{total !== 1 ? "s" : ""}
        {q ? ` matching "${q}"` : ""}
      </p>

      {error && q && (
        <div style={{ padding: "10px 14px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Loading…</div>
        ) : vehicles.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center" }}>
            {q ? (
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>No vehicles match your search.</p>
            ) : (
              <>
                <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.25 }}>🚗</div>
                <p style={{ color: "var(--text-primary)", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                  No vehicles yet
                </p>
                <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>
                  Add your first vehicle to get started.
                </p>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <AddVehicleModal dealerId={dealerId} onSaved={() => fetchVehicles()} label="+ Add Vehicle" />
                  <AddVehicleModal dealerId={dealerId} onSaved={() => fetchVehicles()} initialTab="import" label="↑ Import Vehicles" />
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-sm" style={{ minWidth: 780 }}>
              <thead>
                <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  {["Stock #", "Year / Make / Model", "VIN", "Condition", "MSRP", "Mileage", "Added", "Decode", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5"
                      style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v, i) => (
                  <tr key={v.id} style={{ borderBottom: i < vehicles.length - 1 ? "1px solid var(--border)" : "none" }}>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                        {v.stock_number}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div style={{ color: "var(--text-primary)", fontWeight: 500, fontSize: 13 }}>
                        {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"}
                      </div>
                      {v.trim && (
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{v.trim}</div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
                        {v.vin ?? "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">{conditionBadge(v.condition)}</td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                      {fmt(v.msrp)}
                    </td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-secondary)" }}>
                      {v.mileage ? v.mileage.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {fmtDate(v.date_added)}
                    </td>
                    <td className="px-3 py-2.5">
                      {v.decode_flagged ? (
                        <span style={{ fontSize: 11, color: "#f57f17", background: "#fffde7", border: "1px solid #fff176", borderRadius: 20, padding: "2px 7px", whiteSpace: "nowrap" }}>
                          ⚠ {SOURCE_LABELS[v.decode_source ?? ""] ?? v.decode_source ?? "?"}
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: "#2e7d32", background: "#e8f5e9", border: "1px solid #c8e6c9", borderRadius: 20, padding: "2px 7px" }}>
                          {SOURCE_LABELS[v.decode_source ?? ""] ?? v.decode_source ?? "—"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/dealer-vehicles/${v.id}/addendum`}
                        style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        Open Builder →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderTop: "1px solid var(--border)", background: "#fafafa" }}>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
              Page {page} of {totalPages} — {total} total
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                style={{ height: 32, padding: "0 12px", background: page <= 1 ? "#f5f6f7" : "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: page <= 1 ? "not-allowed" : "pointer", color: page <= 1 ? "var(--text-muted)" : "var(--text-primary)" }}>
                Previous
              </button>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
                style={{ height: 32, padding: "0 12px", background: page >= totalPages ? "#f5f6f7" : "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: page >= totalPages ? "not-allowed" : "pointer", color: page >= totalPages ? "var(--text-muted)" : "var(--text-primary)" }}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
