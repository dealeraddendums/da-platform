"use client";

import { useState, useEffect, useCallback } from "react";
import type { VehicleRow } from "@/lib/vehicles";
import { parsePhotos, vehicleCondition } from "@/lib/vehicles";
import VehicleDetail from "./VehicleDetail";
import type { DealerRow } from "@/lib/db";

type InventoryResponse = {
  data: VehicleRow[];
  total: number;
  page: number;
  per_page: number;
  dealer_id: string;
};

type DealerSearchResponse = {
  data: DealerRow[];
  total: number;
};

type Props = {
  /** Fixed for dealer roles; null for admin roles (must pick a dealer). */
  fixedDealerId: string | null;
  role: string;
  groupId: string | null;
};

const PER_PAGE = 50;

type Condition = "all" | "new" | "used" | "cpo";
type Status = "active" | "all";

export default function VehicleInventory({ fixedDealerId, role, groupId }: Props) {
  const [dealerId, setDealerId] = useState<string | null>(fixedDealerId);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [condition, setCondition] = useState<Condition>("all");
  const [status, setStatus] = useState<Status>("active");
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleRow | null>(null);

  const isSuperAdmin = role === "super_admin";
  const isGroupAdmin = role === "group_admin";
  const needsPicker = (isSuperAdmin || isGroupAdmin) && !dealerId;

  const fetchVehicles = useCallback(async () => {
    if (!dealerId) return;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      dealer_id: dealerId,
      page: String(page),
      per_page: String(PER_PAGE),
      condition,
      status,
    });
    if (q) params.set("q", q);

    try {
      const res = await fetch(`/api/vehicles?${params.toString()}`);
      const json = await res.json() as InventoryResponse & { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Failed to load inventory");
        setVehicles([]);
      } else {
        setVehicles(json.data);
        setTotal(json.total);
      }
    } catch {
      setError("Network error — could not load inventory");
    } finally {
      setLoading(false);
    }
  }, [dealerId, page, condition, status, q]);

  useEffect(() => {
    void fetchVehicles();
  }, [fetchVehicles]);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setQ(searchInput);
  }

  const totalPages = Math.ceil(total / PER_PAGE);
  const from = (page - 1) * PER_PAGE + 1;
  const to = Math.min(page * PER_PAGE, total);

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          Vehicle Inventory
        </h1>
        <p className="text-sm mt-0.5" style={{ color: "rgba(255,255,255,0.6)" }}>
          {dealerId ? (total > 0 ? `${total.toLocaleString()} vehicles` : "No vehicles") : "Select a dealer to view inventory"}
        </p>
      </div>

      {/* Dealer picker for admin roles */}
      {(isSuperAdmin || isGroupAdmin) && (
        <DealerPicker
          groupId={groupId}
          isSuperAdmin={isSuperAdmin}
          current={dealerId}
          onChange={(id) => { setDealerId(id); setPage(1); setVehicles([]); }}
        />
      )}

      {/* Filters */}
      {dealerId && (
        <div className="card p-4 mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Search */}
            <form onSubmit={handleSearch} className="flex items-center gap-2 flex-1 min-w-0">
              <input
                className="input"
                style={{ maxWidth: 280 }}
                placeholder="VIN, stock #, make, model…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
              <button type="submit" className="btn btn-secondary" style={{ flexShrink: 0 }}>
                Search
              </button>
              {q && (
                <button
                  type="button"
                  className="text-sm"
                  style={{ color: "var(--text-muted)" }}
                  onClick={() => { setSearchInput(""); setQ(""); setPage(1); }}
                >
                  Clear
                </button>
              )}
            </form>

            {/* Condition filter */}
            <div className="flex items-center gap-1">
              {(["all", "new", "used", "cpo"] as Condition[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setCondition(c); setPage(1); }}
                  className="text-xs font-medium px-3 py-1.5 rounded"
                  style={{
                    background: condition === c ? "var(--orange)" : "var(--bg-subtle)",
                    color: condition === c ? "var(--text-on-orange)" : "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {c === "all" ? "All" : c === "new" ? "New" : c === "used" ? "Used" : "CPO"}
                </button>
              ))}
            </div>

            {/* Status filter */}
            <div className="flex items-center gap-1">
              {(["active", "all"] as Status[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setStatus(s); setPage(1); }}
                  className="text-xs font-medium px-3 py-1.5 rounded"
                  style={{
                    background: status === s ? "var(--blue)" : "var(--bg-subtle)",
                    color: status === s ? "#fff" : "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {s === "active" ? "In Stock" : "All"}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="card p-4 mb-4" style={{ borderLeft: "3px solid var(--error)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--error)" }}>
            {error}
          </p>
          {error.includes("Aurora") || error.includes("connect") ? (
            <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
              Vehicle inventory is only available when the app is running on the production server.
            </p>
          ) : null}
        </div>
      )}

      {/* Vehicle table */}
      {dealerId && !error && (
        <>
          <div className="card overflow-hidden">
            {loading ? (
              <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>Loading…</div>
            ) : vehicles.length === 0 ? (
              <div className="p-8 text-center" style={{ color: "var(--text-muted)" }}>
                {q || condition !== "all" ? "No vehicles match your filters." : "No vehicles found for this dealer."}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                    {["Photo", "Vehicle", "VIN / Stock", "Condition", "MSRP", "Color", "Miles", "In Stock", ""].map((h) => (
                      <th
                        key={h}
                        className="text-left px-3 py-2.5 font-semibold"
                        style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((v, i) => {
                    const photos = parsePhotos(v.PHOTOS);
                    const cond = vehicleCondition(v);
                    return (
                      <tr
                        key={v.id}
                        style={{
                          borderBottom: i < vehicles.length - 1 ? "1px solid var(--border)" : "none",
                          cursor: "pointer",
                        }}
                        onClick={() => setSelectedVehicle(v)}
                      >
                        {/* Photo */}
                        <td className="px-3 py-2" style={{ width: 56 }}>
                          {photos[0] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={photos[0]}
                              alt=""
                              style={{ width: 48, height: 36, objectFit: "cover", borderRadius: 3, background: "var(--bg-subtle)" }}
                            />
                          ) : (
                            <div style={{ width: 48, height: 36, borderRadius: 3, background: "var(--bg-subtle)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" />
                                <path d="M3 9l4-4 4 4 4-4 4 4" />
                              </svg>
                            </div>
                          )}
                        </td>

                        {/* Vehicle */}
                        <td className="px-3 py-2">
                          <div className="font-medium" style={{ color: "var(--text-primary)" }}>
                            {[v.YEAR, v.MAKE, v.MODEL].filter(Boolean).join(" ")}
                          </div>
                          {v.TRIM && (
                            <div className="text-xs" style={{ color: "var(--text-muted)" }}>{v.TRIM}</div>
                          )}
                        </td>

                        {/* VIN / Stock */}
                        <td className="px-3 py-2">
                          <div className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{v.VIN_NUMBER}</div>
                          {v.STOCK_NUMBER && (
                            <div className="text-xs" style={{ color: "var(--text-muted)" }}>#{v.STOCK_NUMBER}</div>
                          )}
                        </td>

                        {/* Condition */}
                        <td className="px-3 py-2">
                          <ConditionBadge cond={cond} />
                        </td>

                        {/* MSRP */}
                        <td className="px-3 py-2 font-medium" style={{ color: "var(--text-primary)" }}>
                          {v.MSRP ? `$${parseInt(v.MSRP, 10).toLocaleString()}` : "—"}
                        </td>

                        {/* Color */}
                        <td className="px-3 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                          {v.EXT_COLOR || "—"}
                        </td>

                        {/* Miles */}
                        <td className="px-3 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>
                          {v.MILEAGE ? parseInt(v.MILEAGE, 10).toLocaleString() : "—"}
                        </td>

                        {/* Date in stock */}
                        <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                          {v.DATE_IN_STOCK ? formatDate(v.DATE_IN_STOCK) : "—"}
                        </td>

                        {/* Action */}
                        <td className="px-3 py-2 text-right">
                          <button
                            className="text-xs font-medium"
                            style={{ color: "var(--blue)" }}
                            onClick={(e) => { e.stopPropagation(); setSelectedVehicle(v); }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {total > PER_PAGE && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
              </p>
              <div className="flex items-center gap-2">
                <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  ← Prev
                </button>
                <span className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                  {page} / {totalPages}
                </span>
                <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Vehicle detail modal */}
      {selectedVehicle && (
        <VehicleDetail
          vehicle={selectedVehicle}
          onClose={() => setSelectedVehicle(null)}
        />
      )}
    </div>
  );
}

// ── Dealer Picker ─────────────────────────────────────────────────────────────

type DealerPickerProps = {
  groupId: string | null;
  isSuperAdmin: boolean;
  current: string | null;
  onChange: (dealerId: string) => void;
};

function DealerPicker({ groupId, isSuperAdmin, current, onChange }: DealerPickerProps) {
  const [dealers, setDealers] = useState<DealerRow[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  // For group_admin: load their group's dealers automatically
  useEffect(() => {
    if (!isSuperAdmin && groupId) {
      setLoading(true);
      void fetch(`/api/groups/${groupId}/dealers`)
        .then((r) => r.json() as Promise<{ data: DealerRow[] }>)
        .then((j) => { setDealers(j.data); setSearched(true); })
        .finally(() => setLoading(false));
    }
  }, [isSuperAdmin, groupId]);

  async function searchDealers(e: React.FormEvent) {
    e.preventDefault();
    if (!searchInput.trim()) return;
    setLoading(true);
    const res = await fetch(`/api/dealers?q=${encodeURIComponent(searchInput)}&active=true&per_page=20`);
    const json = (await res.json()) as DealerSearchResponse;
    setDealers(json.data);
    setSearched(true);
    setLoading(false);
  }

  return (
    <div className="card p-4 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
        {isSuperAdmin ? "Select Dealer" : "Select Dealer in Your Group"}
      </p>

      {isSuperAdmin && (
        <form onSubmit={(e) => void searchDealers(e)} className="flex items-center gap-2 mb-3">
          <input
            className="input"
            style={{ maxWidth: 300 }}
            placeholder="Search dealer name or ID…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={loading}>
            {loading ? "…" : "Search"}
          </button>
        </form>
      )}

      {loading && !searched && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>Loading dealers…</p>
      )}

      {searched && dealers.length === 0 && (
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>No dealers found.</p>
      )}

      {dealers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {dealers.map((d) => (
            <button
              key={d.dealer_id}
              type="button"
              onClick={() => onChange(d.dealer_id)}
              className="text-sm font-medium px-3 py-1.5 rounded"
              style={{
                background: current === d.dealer_id ? "var(--blue)" : "var(--bg-subtle)",
                color: current === d.dealer_id ? "#fff" : "var(--text-primary)",
                border: `1px solid ${current === d.dealer_id ? "var(--blue)" : "var(--border)"}`,
              }}
            >
              {d.name}
              <span className="ml-1.5 font-mono text-xs opacity-60">{d.dealer_id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ConditionBadge({ cond }: { cond: "New" | "Used" | "CPO" }) {
  const styles: Record<string, { bg: string; color: string; border: string }> = {
    New: { bg: "#e3f2fd", color: "#1565c0", border: "#bbdefb" },
    Used: { bg: "#fff8e1", color: "#e65100", border: "#ffe0b2" },
    CPO: { bg: "#e8f5e9", color: "#2e7d32", border: "#c8e6c9" },
  };
  const s = styles[cond];
  return (
    <span
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
      style={{ background: s.bg, color: s.color, border: `1px solid ${s.border}` }}
    >
      {cond}
    </span>
  );
}

function formatDate(d: string): string {
  if (!d || d === "0000-00-00") return "";
  // Handle both "YYYY-MM-DD" and "M/D/YYYY" formats
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
