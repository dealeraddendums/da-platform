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
type PrintFilter = "all" | "printed" | "unprinted";

export default function VehicleInventory({ fixedDealerId, role, groupId }: Props) {
  const [dealerId, setDealerId] = useState<string | null>(fixedDealerId);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [condition, setCondition] = useState<Condition>("all");
  const [status, setStatus] = useState<Status>("active");
  const [printFilter, setPrintFilter] = useState<PrintFilter>("all");
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleRow | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [bulkPrinting, setBulkPrinting] = useState(false);

  const isSuperAdmin = role === "super_admin";
  const isGroupAdmin = role === "group_admin";
  const needsPicker = (isSuperAdmin || isGroupAdmin) && !dealerId;

  const fetchVehicles = useCallback(async () => {
    if (!dealerId) return;
    setLoading(true);
    setError(null);
    setCheckedIds(new Set());

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

  const displayedVehicles = printFilter === "all"
    ? vehicles
    : printFilter === "printed"
    ? vehicles.filter((v) => v.PRINT_STATUS === "1")
    : vehicles.filter((v) => v.PRINT_STATUS !== "1");

  function toggleCheck(id: number) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === displayedVehicles.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(displayedVehicles.map((v) => v.id)));
    }
  }

  async function bulkPrint(docType: "addendum" | "infosheet" | "buyer_guide") {
    if (checkedIds.size === 0) return;
    const ids = Array.from(checkedIds);

    // Single vehicle: open in builder instead of bulk PDF
    if (ids.length === 1) {
      window.open(`/builder/${ids[0]}?doc_type=${docType}`, "_blank");
      setCheckedIds(new Set());
      return;
    }

    setBulkPrinting(true);
    try {
      const paperSize = docType === "infosheet" ? "infosheet" : "standard";
      const res = await fetch("/api/pdf/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicleIds: ids, docType, paperSize }),
      });

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        alert(json.error ?? "Bulk PDF generation failed");
        return;
      }

      const contentType = res.headers.get("Content-Type") ?? "";
      if (contentType.includes("application/zip")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `addendums_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        // Single URL returned
        const json = await res.json() as { url?: string };
        if (json.url) window.open(json.url, "_blank");
      }

      setCheckedIds(new Set());
    } finally {
      setBulkPrinting(false);
    }
  }

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
        <div className="card p-4 mb-4" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Search row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
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
            {/* Status toggle (In Stock / All) */}
            <div style={{ display: "flex", gap: 4 }}>
              {(["active", "all"] as Status[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => { setStatus(s); setPage(1); }}
                  style={{
                    height: 30, padding: "0 12px", fontSize: 12, fontWeight: 500,
                    borderRadius: 4, cursor: "pointer",
                    background: status === s ? "var(--blue)" : "var(--bg-subtle)",
                    color: status === s ? "#fff" : "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {s === "active" ? "In Stock" : "All Stock"}
                </button>
              ))}
            </div>
          </div>

          {/* Row 1: Vehicle Type */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", width: 90, flexShrink: 0 }}>
              Vehicle Type
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {(["all", "new", "used", "cpo"] as Condition[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setCondition(c); setPage(1); }}
                  style={{
                    height: 30, padding: "0 14px", fontSize: 12, fontWeight: 500,
                    borderRadius: 4, cursor: "pointer",
                    background: condition === c ? "var(--orange)" : "var(--bg-subtle)",
                    color: condition === c ? "#333" : "var(--text-secondary)",
                    border: condition === c ? "1px solid #e69500" : "1px solid var(--border)",
                  }}
                >
                  {c === "all" ? "All" : c === "new" ? "New" : c === "used" ? "Used" : "CPO"}
                </button>
              ))}
            </div>
          </div>

          {/* Row 2: Print Status */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", width: 90, flexShrink: 0 }}>
              Print Status
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {(["all", "printed", "unprinted"] as PrintFilter[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrintFilter(p)}
                  style={{
                    height: 30, padding: "0 14px", fontSize: 12, fontWeight: 500,
                    borderRadius: 4, cursor: "pointer",
                    background: printFilter === p ? "var(--success)" : "var(--bg-subtle)",
                    color: printFilter === p ? "#fff" : "var(--text-secondary)",
                    border: printFilter === p ? "1px solid #43a047" : "1px solid var(--border)",
                  }}
                >
                  {p === "all" ? "All" : p === "printed" ? "Printed" : "Unprinted"}
                </button>
              ))}
              <button
                type="button"
                disabled
                title="Coming soon — mobile app"
                style={{
                  height: 30, padding: "0 14px", fontSize: 12, fontWeight: 500,
                  borderRadius: 4, cursor: "not-allowed",
                  background: "var(--bg-subtle)", color: "var(--text-muted)",
                  border: "1px solid var(--border)", opacity: 0.55,
                }}
              >
                Queued
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk action toolbar */}
      {checkedIds.size > 0 && (
        <div
          className="card p-3 mb-4 flex items-center gap-3"
          style={{ borderLeft: "3px solid var(--orange)" }}
        >
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {checkedIds.size} selected
          </span>
          <button
            type="button"
            className="btn btn-primary text-xs"
            style={{ height: 30 }}
            disabled={bulkPrinting}
            onClick={() => void bulkPrint("addendum")}
          >
            Addendum
          </button>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            style={{ height: 30 }}
            disabled={bulkPrinting}
            onClick={() => void bulkPrint("infosheet")}
          >
            Info Sheet
          </button>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            style={{ height: 30 }}
            disabled={bulkPrinting}
            onClick={() => void bulkPrint("buyer_guide")}
          >
            Buyer Guide
          </button>
          <button
            type="button"
            className="text-xs"
            style={{ color: "var(--text-muted)", marginLeft: "auto" }}
            onClick={() => setCheckedIds(new Set())}
          >
            Clear
          </button>
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
                    <th className="px-3 py-2.5" style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        checked={checkedIds.size === displayedVehicles.length && displayedVehicles.length > 0}
                        onChange={toggleAll}
                      />
                    </th>
                    {["Photo", "Vehicle", "VIN / Stock", "Cond.", "MSRP", "Color", "Miles", "Printed", ""].map((h) => (
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
                  {displayedVehicles.map((v, i) => {
                    const photos = parsePhotos(v.PHOTOS);
                    const cond = vehicleCondition(v);
                    const printed = v.PRINT_STATUS === "1";
                    const checked = checkedIds.has(v.id);
                    return (
                      <tr
                        key={v.id}
                        style={{
                          borderBottom: i < displayedVehicles.length - 1 ? "1px solid var(--border)" : "none",
                          background: checked ? "rgba(25,118,210,0.04)" : undefined,
                          cursor: "pointer",
                        }}
                        onClick={() => setSelectedVehicle(v)}
                      >
                        {/* Checkbox */}
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCheck(v.id)}
                          />
                        </td>

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

                        {/* Print status */}
                        <td className="px-3 py-2">
                          {printed ? (
                            <span
                              className="text-xs font-semibold px-2 py-0.5 rounded-full"
                              style={{ background: "#e8f5e9", color: "#2e7d32" }}
                            >
                              ✓ Printed
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: "var(--text-muted)" }}>—</span>
                          )}
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <a
                              href={`/vehicles/${v.id}/addendum`}
                              className="text-xs font-medium"
                              style={{
                                color: printed ? "var(--success)" : "var(--blue)",
                                textDecoration: "none",
                                whiteSpace: "nowrap",
                              }}
                              title="Addendum options"
                            >
                              Addendum
                            </a>
                            <button
                              className="text-xs font-medium"
                              style={{ color: "var(--text-muted)" }}
                              onClick={() => setSelectedVehicle(v)}
                            >
                              Details
                            </button>
                          </div>
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
