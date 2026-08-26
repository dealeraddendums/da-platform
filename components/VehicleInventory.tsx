"use client";

import { useState, useEffect, useCallback } from "react";
import Pager from "@/components/Pager";
import type { VehicleRow } from "@/lib/vehicles";
import { parsePhotos, vehicleCondition } from "@/lib/vehicles";
import VehicleDetail from "./VehicleDetail";
import PrintPreviewModal from "./PrintPreviewModal";
import PdfBuildingOverlay from "./PdfBuildingOverlay";
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
  /** Print-eligibility gate resolved server-side; null = allowed. */
  printGate?: { ok: boolean; message?: string };
};

const PER_PAGE_OPTIONS = [15, 25, 50, 0] as const; // 0 = All

type Condition = "all" | "new" | "used" | "cpo";
type Status = "active" | "all";
type PrintFilter = "all" | "printed" | "unprinted" | "queued";

export default function VehicleInventory({ fixedDealerId, role, groupId, printGate }: Props) {
  const canPrint = printGate?.ok !== false;
  const printBlockedMsg = printGate?.message;
  const [dealerId, setDealerId] = useState<string | null>(fixedDealerId);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(15);
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
  const [bulkModal, setBulkModal] = useState<{ url: string; docType: "addendum" | "infosheet" | "buyer_guide"; count: number; printToken?: string } | null>(null);
  const [clearingHistory, setClearingHistory] = useState(false);

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
      per_page: String(perPage === 0 ? 9999 : perPage),
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
  }, [dealerId, page, perPage, condition, status, q]);

  const displayedVehicles = printFilter === "all"
    ? vehicles
    : printFilter === "printed"
    ? vehicles.filter((v) => !!v.supabase_printed)
    : printFilter === "queued"
    ? vehicles.filter((v) => v.print_queue === 1)
    : vehicles.filter((v) => !v.supabase_printed);

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

  async function clearPrintHistoryForSelection() {
    if (checkedIds.size === 0) return;
    const count = checkedIds.size;
    const ok = window.confirm(
      `Clear print history and saved products for ${count} vehicle${count === 1 ? "" : "s"}? This can't be undone.`,
    );
    if (!ok) return;
    setClearingHistory(true);
    try {
      const res = await fetch("/api/print/clear-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vehicleIds: Array.from(checkedIds) }),
      });
      const json = await res.json() as { cleared_vehicles?: number; error?: string };
      if (!res.ok) {
        // Surface the real server message (|| not ?? so an empty string still
        // shows a useful fallback) instead of a generic alert.
        alert(json.error || `Failed to clear print history (HTTP ${res.status})`);
        return;
      }
      setCheckedIds(new Set());
      // Hard reload so the dashboard counts (Printed this month / Unprinted)
      // refresh alongside the inventory list — they're rendered by the
      // parent dashboard page, not this component.
      window.location.reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to clear print history");
    } finally {
      setClearingHistory(false);
    }
  }

  async function bulkPrint(docType: "addendum" | "infosheet" | "buyer_guide") {
    if (checkedIds.size === 0) return;
    const ids = Array.from(checkedIds);

    // Single vehicle: addendum goes to builder; infosheet/buyer_guide go to the addendum page
    if (ids.length === 1) {
      const singleUrl = docType === "addendum"
        ? `/builder/${ids[0]}`
        : `/dealer-vehicles/${ids[0]}/addendum?type=${docType}`;
      window.open(singleUrl, "_blank");
      setCheckedIds(new Set());
      return;
    }

    setBulkPrinting(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const res = await fetch("/api/pdf/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No paperSize: each vehicle renders at its OWN template width (the
        // server resolves it per job — a global value here flattened narrow
        // templates to regular on every bulk print until 2026-08-21).
        body: JSON.stringify({ vehicleIds: ids, docType }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        alert(json.error ?? "Bulk PDF generation failed");
        return;
      }

      const printToken = res.headers.get("X-Print-Token") ?? undefined;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setBulkModal({ url, docType, count: ids.length, printToken });
      setCheckedIds(new Set());
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? "Bulk PDF generation timed out. Try fewer vehicles."
        : "Bulk PDF generation failed";
      alert(msg);
    } finally {
      clearTimeout(timeout);
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

  const effectivePerPage = perPage === 0 ? total : perPage;
  const totalPages = effectivePerPage > 0 ? Math.ceil(total / effectivePerPage) : 1;
  const from = (page - 1) * effectivePerPage + 1;
  const to = Math.min(page * effectivePerPage, total);

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
              {(["all", "printed", "unprinted", "queued"] as PrintFilter[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrintFilter(p)}
                  title={p === "queued" ? "Vehicles queued from the mobile app" : undefined}
                  style={{
                    height: 30, padding: "0 14px", fontSize: 12, fontWeight: 500,
                    borderRadius: 4, cursor: "pointer",
                    // Queued uses the orange token — matches the queued Print
                    // Now cue (mobile print queue).
                    background: printFilter === p ? (p === "queued" ? "#ffa500" : "var(--success)") : "var(--bg-subtle)",
                    color: printFilter === p ? "#fff" : "var(--text-secondary)",
                    border: printFilter === p ? (p === "queued" ? "1px solid #e69500" : "1px solid #43a047") : "1px solid var(--border)",
                  }}
                >
                  {p === "all" ? "All" : p === "printed" ? "Printed" : p === "unprinted" ? "Unprinted" : "Queued"}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Bulk action toolbar */}
      {checkedIds.size > 0 && (
        <div
          className="card p-3 mb-4 flex items-center gap-3"
          style={{ borderLeft: "3px solid var(--orange)", flexWrap: "wrap" }}
        >
          <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {checkedIds.size} selected
          </span>
          {checkedIds.size > 15 && (
            <span className="text-xs" style={{ color: "#ff5252" }}>
              You can print a maximum of 15 vehicles at once. Please select 15 or fewer vehicles.
            </span>
          )}
          {!canPrint && printBlockedMsg && (
            <span className="text-xs" style={{ color: "#ff5252" }}>{printBlockedMsg}</span>
          )}
          <button
            type="button"
            className="btn btn-primary text-xs"
            style={{ height: 30, opacity: (checkedIds.size > 15 || !canPrint) ? 0.45 : 1 }}
            disabled={bulkPrinting || checkedIds.size > 15 || !canPrint}
            title={!canPrint ? printBlockedMsg : undefined}
            onClick={() => void bulkPrint("addendum")}
          >
            Print Now ({checkedIds.size})
          </button>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            style={{ height: 30, opacity: (checkedIds.size > 15 || !canPrint) ? 0.45 : 1 }}
            disabled={bulkPrinting || checkedIds.size > 15 || !canPrint}
            title={!canPrint ? printBlockedMsg : undefined}
            onClick={() => void bulkPrint("infosheet")}
          >
            Info Sheet ({checkedIds.size})
          </button>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            style={{ height: 30, opacity: (checkedIds.size > 15 || !canPrint) ? 0.45 : 1 }}
            disabled={bulkPrinting || checkedIds.size > 15 || !canPrint}
            title={!canPrint ? printBlockedMsg : undefined}
            onClick={() => void bulkPrint("buyer_guide")}
          >
            Buyer Guide ({checkedIds.size})
          </button>
          <button
            type="button"
            className="btn btn-secondary text-xs"
            style={{ height: 30 }}
            disabled={bulkPrinting || clearingHistory}
            onClick={() => void clearPrintHistoryForSelection()}
            title="Delete print history and saved products for the selected vehicles"
          >
            {clearingHistory ? "Clearing…" : `Clear Print History (${checkedIds.size})`}
          </button>
          {!bulkPrinting && (
            <button
              type="button"
              className="text-xs"
              style={{ color: "var(--text-muted)", marginLeft: "auto" }}
              onClick={() => setCheckedIds(new Set())}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="card p-4 mb-4" style={{ borderLeft: "3px solid var(--error)" }}>
          <p className="text-sm font-medium" style={{ color: "var(--error)" }}>
            {error}
          </p>
          {error.includes("connect") || error.includes("ENOTFOUND") ? (
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
                    const printed = !!v.supabase_printed;
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
                                // Orange = queued from mobile (this table has no
                                // per-row Print Now button; the Addendum link is
                                // the print entry point).
                                color: v.print_queue === 1 ? "#ffa500" : printed ? "var(--success)" : "var(--blue)",
                                textDecoration: "none",
                                whiteSpace: "nowrap",
                              }}
                              title={v.print_queue === 1 ? "Queued from mobile — waiting to be printed" : "Addendum options"}
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
          {total > 0 && (
            <Pager page={page} totalPages={totalPages} onPage={setPage} light
              summary={
                <>
                  <p className="text-sm" style={{ color: "rgba(255,255,255,0.6)" }}>
                    {perPage === 0 ? `All ${total.toLocaleString()} vehicles` : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
                  </p>
                  <select
                    value={perPage}
                    onChange={e => { setPerPage(Number(e.target.value)); setPage(1); }}
                    style={{ height: 28, padding: "0 6px", fontSize: 12, border: "1px solid rgba(255,255,255,0.25)", borderRadius: 4, background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)", cursor: "pointer" }}
                  >
                    {PER_PAGE_OPTIONS.map(n => (
                      <option key={n} value={n} style={{ background: "#2a2b3c", color: "#fff" }}>{n === 0 ? "All" : n}</option>
                    ))}
                  </select>
                  <span className="text-sm" style={{ color: "rgba(255,255,255,0.4)" }}>per page</span>
                </>
              } />
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

      {/* Bulk print preview modal */}
      {bulkModal && (
        <PrintPreviewModal
          docType={bulkModal.docType}
          vehicleName={`${bulkModal.count} Vehicles`}
          preloadedUrl={bulkModal.url}
          printToken={bulkModal.printToken}
          onClose={() => setBulkModal(null)}
        />
      )}

      <PdfBuildingOverlay visible={bulkPrinting} />
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
