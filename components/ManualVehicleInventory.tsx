"use client";

import { useState, useEffect, useCallback } from "react";
import AddVehicleModal from "./AddVehicleModal";
import EditVehicleModal from "./EditVehicleModal";
import VehicleHistoryPanel from "./VehicleHistoryPanel";
import PrintPreviewModal from "./PrintPreviewModal";
import type { DealerVehicleRow, DealerVehicleArchiveRow } from "@/lib/db";

type Props = { dealerId: string; isSuperAdmin?: boolean };

type ListResponse = {
  data: DealerVehicleRow[];
  total: number;
  page: number;
  per_page: number;
  printedTypes?: Record<string, string[]>;
};

const PER_PAGE_OPTIONS = [15, 25, 50, 0] as const; // 0 = All

function conditionBadge(c: string) {
  const styles: Record<string, React.CSSProperties> = {
    New:       { background: "#e3f2fd", color: "#1565c0", border: "1px solid #bbdefb" },
    Used:      { background: "#f3e5f5", color: "#6a1b9a", border: "1px solid #e1bee7" },
    Certified: { background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9" },
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

function PrintNowBtn({ vehicleId, everPrinted }: {
  vehicleId: string;
  everPrinted: boolean;
}) {
  return (
    <a
      href={`/vehicles/${vehicleId}/addendum`}
      style={{
        display: "inline-block",
        height: 28, padding: "0 11px", fontSize: 11, fontWeight: 600,
        borderRadius: 4, whiteSpace: "nowrap", textDecoration: "none",
        lineHeight: "28px",
        background: everPrinted ? "#1976d2" : "#fff",
        color: everPrinted ? "#fff" : "#333",
        border: everPrinted ? "1px solid #1565c0" : "1px solid #c0c0c0",
      }}
    >
      Print Now
    </a>
  );
}

function SortTh({ label, col, sortBy, sortDir, onSort }: {
  label: string; col: string; sortBy: string; sortDir: "asc" | "desc";
  onSort: (col: string) => void;
}) {
  const active = sortBy === col;
  return (
    <th
      className="text-left px-3 py-2.5"
      onClick={() => onSort(col)}
      style={{
        fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const,
        letterSpacing: "0.05em", color: active ? "#1976d2" : "var(--text-muted)",
        whiteSpace: "nowrap" as const, cursor: "pointer", userSelect: "none" as const,
      }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: active ? 1 : 0.35, fontSize: 10 }}>
        {active ? (sortDir === "asc" ? "↑" : "↓") : "⇅"}
      </span>
    </th>
  );
}

export default function ManualVehicleInventory({ dealerId, isSuperAdmin = false }: Props) {
  const [vehicles, setVehicles] = useState<DealerVehicleRow[]>([]);
  const [printedTypes, setPrintedTypes] = useState<Record<string, string[]>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(15);
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [condition, setCondition] = useState("all");
  const [printStatus, setPrintStatus] = useState("all");
  const [sortBy, setSortBy] = useState("date_added");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiEnabled, setAiEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((json: { ai_content_default?: boolean }) => {
        if (json.ai_content_default) setAiEnabled(true);
      })
      .catch(() => null);
  }, []);

  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [bulkPrinting, setBulkPrinting] = useState(false);
  const [bulkModal, setBulkModal] = useState<{ url: string; docType: "addendum" | "infosheet" | "buyer_guide"; count: number } | null>(null);
  const [editingVehicle, setEditingVehicle] = useState<DealerVehicleRow | null>(null);
  const [historyVehicle, setHistoryVehicle] = useState<{ id: string; stock_number: string } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Archive modal (super_admin only)
  const [showArchive, setShowArchive] = useState(false);
  const [archiveRows, setArchiveRows] = useState<DealerVehicleArchiveRow[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function openArchive() {
    setShowArchive(true);
    setArchiveLoading(true);
    setArchiveError(null);
    const res = await fetch(`/api/admin/vehicle-archive?dealer_id=${encodeURIComponent(dealerId)}`);
    const json = await res.json() as { data?: DealerVehicleArchiveRow[]; error?: string };
    setArchiveLoading(false);
    if (!res.ok) { setArchiveError(json.error ?? "Failed to load archive"); return; }
    setArchiveRows(json.data ?? []);
  }

  async function handleRestore(archiveId: string) {
    if (!confirm("Restore this vehicle to active inventory with status 'Inactive'?")) return;
    setRestoringId(archiveId);
    const res = await fetch("/api/admin/vehicle-archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", id: archiveId }),
    });
    const json = await res.json() as { vehicle?: DealerVehicleRow; error?: string };
    setRestoringId(null);
    if (!res.ok) { alert(json.error ?? "Restore failed"); return; }
    setArchiveRows((prev) => prev.filter((r) => r.id !== archiveId));
    void fetchVehicles();
  }

  const fetchVehicles = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCheckedIds(new Set());
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage === 0 ? 9999 : perPage), condition, print_status: printStatus, sort_by: sortBy, sort_dir: sortDir });
    if (q) params.set("q", q);

    const res = await fetch(`/api/dealer-vehicles?${params}`);
    const json = await res.json() as ListResponse & { error?: string };
    setLoading(false);
    if (!res.ok) {
      setError(json.error ?? "Failed to load vehicles");
    } else {
      setVehicles(json.data);
      setTotal(json.total);
      setPrintedTypes(json.printedTypes ?? {});
    }
  }, [page, perPage, condition, printStatus, sortBy, sortDir, q]);

  useEffect(() => { void fetchVehicles(); }, [fetchVehicles]);

  const effectivePerPage = perPage === 0 ? total : perPage;
  const totalPages = effectivePerPage > 0 ? Math.ceil(total / effectivePerPage) : 1;

  function toggleCheck(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (checkedIds.size === vehicles.length) {
      setCheckedIds(new Set());
    } else {
      setCheckedIds(new Set(vehicles.map((v) => v.id)));
    }
  }

  async function bulkPrint(docType: "addendum" | "infosheet" | "buyer_guide") {
    const ids = Array.from(checkedIds);
    if (!ids.length) return;

    // Single vehicle: go to addendum options screen
    if (ids.length === 1) {
      window.open(`/dealer-vehicles/${ids[0]}/addendum?type=${docType}`, "_blank");
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

      const json = await res.json() as { url?: string };
      if (json.url) {
        setBulkModal({ url: json.url, docType, count: ids.length });
        setCheckedIds(new Set());
      }
    } catch {
      alert("Bulk PDF generation failed");
    } finally {
      setBulkPrinting(false);
    }
  }

  function handleSort(col: string) {
    if (sortBy === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(col);
      setSortDir(col === "date_added" ? "desc" : "asc");
    }
    setPage(1);
  }

  async function confirmBulkDelete() {
    setDeleting(true);
    const ids = Array.from(checkedIds);
    const res = await fetch("/api/dealer-vehicles/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    setDeleting(false);
    setShowDeleteConfirm(false);
    if (res.ok) {
      setCheckedIds(new Set());
      void fetchVehicles();
    } else {
      const json = await res.json() as { error?: string };
      alert(json.error ?? "Delete failed");
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <form
          onSubmit={(e) => { e.preventDefault(); setQ(searchInput); setPage(1); }}
          style={{ display: "flex", gap: 6 }}
        >
          <input
            type="text" value={searchInput}
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
          <option value="Certified">Certified</option>
        </select>

        <select
          value={printStatus}
          onChange={(e) => { setPrintStatus(e.target.value); setPage(1); }}
          style={{ height: 36, border: "1px solid var(--border)", borderRadius: 4, padding: "0 8px", fontSize: 13 }}
        >
          <option value="all">All Print Status</option>
          <option value="printed">Printed</option>
          <option value="unprinted">Unprinted</option>
        </select>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {isSuperAdmin && (
            <button
              onClick={openArchive}
              style={{ height: 36, padding: "0 12px", background: "#fff", color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer" }}
            >
              View Archive
            </button>
          )}
          <AddVehicleModal dealerId={dealerId} aiEnabled={aiEnabled} onSaved={() => fetchVehicles()} label="+ Add Vehicle" />
          <AddVehicleModal dealerId={dealerId} aiEnabled={aiEnabled} onSaved={() => fetchVehicles()} initialTab="import" label="↑ Import Vehicles" />
        </div>
      </div>

      {/* Summary */}
      <p style={{ fontSize: 13, color: "rgba(255,255,255,0.75)", marginBottom: 8 }}>
        {total.toLocaleString()} vehicle{total !== 1 ? "s" : ""}
        {q ? ` matching "${q}"` : ""}
      </p>

      {/* Bulk actions toolbar */}
      {checkedIds.size > 0 && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          padding: "8px 14px", marginBottom: 10,
          background: "#fff", border: "1px solid var(--border)", borderLeft: "3px solid var(--orange)",
          borderRadius: 4,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginRight: 4 }}>
            {bulkPrinting ? `Generating ${checkedIds.size} PDF${checkedIds.size !== 1 ? "s" : ""}…` : `${checkedIds.size} selected`}
          </span>
          <button onClick={() => void bulkPrint("addendum")} disabled={bulkPrinting}
            style={{ height: 30, padding: "0 12px", fontSize: 12, fontWeight: 600, background: bulkPrinting ? "#bbb" : "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: bulkPrinting ? "not-allowed" : "pointer" }}>
            {bulkPrinting ? "…" : "Print Addendums"}
          </button>
          <button onClick={() => void bulkPrint("infosheet")} disabled={bulkPrinting}
            style={{ height: 30, padding: "0 12px", fontSize: 12, fontWeight: 600, background: bulkPrinting ? "#bbb" : "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: bulkPrinting ? "not-allowed" : "pointer" }}>
            {bulkPrinting ? "…" : "Print Info Sheets"}
          </button>
          <button onClick={() => void bulkPrint("buyer_guide")} disabled={bulkPrinting}
            style={{ height: 30, padding: "0 12px", fontSize: 12, fontWeight: 600, background: bulkPrinting ? "#bbb" : "#1976d2", color: "#fff", border: "none", borderRadius: 4, cursor: bulkPrinting ? "not-allowed" : "pointer" }}>
            {bulkPrinting ? "…" : "Print Buyer Guides"}
          </button>
          {!bulkPrinting && (
            <>
              <button onClick={() => setShowDeleteConfirm(true)}
                style={{ height: 30, padding: "0 12px", fontSize: 12, fontWeight: 600, background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", marginLeft: 4 }}>
                Delete
              </button>
              <button onClick={() => setCheckedIds(new Set())}
                style={{ height: 30, padding: "0 10px", fontSize: 12, background: "#fff", border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", color: "var(--text-muted)", marginLeft: "auto" }}>
                Cancel
              </button>
            </>
          )}
        </div>
      )}

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
                <p style={{ color: "var(--text-primary)", fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No vehicles yet</p>
                <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 24 }}>Add your first vehicle to get started.</p>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                  <AddVehicleModal dealerId={dealerId} aiEnabled={aiEnabled} onSaved={() => fetchVehicles()} label="+ Add Vehicle" />
                  <AddVehicleModal dealerId={dealerId} aiEnabled={aiEnabled} onSaved={() => fetchVehicles()} initialTab="import" label="↑ Import Vehicles" />
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-sm" style={{ minWidth: 960 }}>
              <thead>
                <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  <th className="px-3 py-2.5" style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={checkedIds.size === vehicles.length && vehicles.length > 0}
                      onChange={toggleAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  {/* Stock # — not sortable */}
                  <th className="text-left px-3 py-2.5" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>Stock #</th>
                  {/* Year / Make / Model — sortable by year */}
                  <SortTh label="Year / Make / Model" col="year" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="VIN" col="vin" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Condition" col="condition" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="MSRP" col="msrp" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <SortTh label="Added" col="date_added" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  {["Edit", "History", "Print Now"].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5" style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v, i) => {
                  const printed = printedTypes[v.id] ?? [];
                  return (
                    <tr key={v.id} style={{ borderBottom: i < vehicles.length - 1 ? "1px solid var(--border)" : "none", background: checkedIds.has(v.id) ? "#f0f7ff" : undefined }}>
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={checkedIds.has(v.id)} onChange={() => toggleCheck(v.id)} style={{ cursor: "pointer" }} />
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{v.stock_number}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div style={{ color: "var(--text-primary)", fontWeight: 500, fontSize: 13 }}>
                          {[v.year, v.make, v.model].filter(Boolean).join(" ") || "—"}
                        </div>
                        {v.trim && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{v.trim}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{v.vin ?? "—"}</span>
                      </td>
                      <td className="px-3 py-2">{conditionBadge(v.condition)}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-secondary)" }}>{fmt(v.msrp)}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtDate(v.date_added)}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setEditingVehicle(v)}
                          style={{ height: 28, padding: "0 10px", fontSize: 11, fontWeight: 600, background: "#fff", color: "#333", border: "1px solid #c0c0c0", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }}
                        >
                          Edit
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => setHistoryVehicle({ id: v.id, stock_number: v.stock_number })}
                          style={{ height: 28, padding: "0 10px", fontSize: 11, fontWeight: 600, background: "#fff", color: "#555", border: "1px solid #c0c0c0", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }}
                          title="View print history"
                        >
                          History
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <PrintNowBtn vehicleId={v.id} everPrinted={printed.length > 0} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderTop: "1px solid var(--border)", background: "#fafafa" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {perPage === 0 ? `All ${total} vehicles` : `Page ${page} of ${totalPages} — ${total} total`}
              </span>
              <select
                value={perPage}
                onChange={e => { setPerPage(Number(e.target.value)); setPage(1); }}
                style={{ height: 28, padding: "0 6px", fontSize: 12, border: "1px solid var(--border)", borderRadius: 4, background: "#fff", color: "var(--text-primary)", cursor: "pointer" }}
              >
                {PER_PAGE_OPTIONS.map(n => (
                  <option key={n} value={n}>{n === 0 ? "All" : n}</option>
                ))}
              </select>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>per page</span>
            </div>
            {totalPages > 1 && (
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
            )}
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editingVehicle && (
        <EditVehicleModal
          vehicle={editingVehicle}
          aiEnabled={aiEnabled}
          onSaved={(updated) => {
            setVehicles((vs) => vs.map((v) => v.id === updated.id ? updated : v));
            setEditingVehicle(null);
          }}
          onClose={() => setEditingVehicle(null)}
        />
      )}

      {/* History panel */}
      {historyVehicle && (
        <VehicleHistoryPanel
          vehicleId={historyVehicle.id}
          stockNumber={historyVehicle.stock_number}
          onClose={() => setHistoryVehicle(null)}
        />
      )}

      {/* Archive modal (super_admin only) */}
      {showArchive && (
        <>
          <div onClick={() => setShowArchive(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            background: "#fff", borderRadius: 6, zIndex: 1001, width: "min(880px, 96vw)",
            maxHeight: "80vh", display: "flex", flexDirection: "column",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          }}>
            {/* Header */}
            <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>Archived Vehicles</h2>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Vehicles inactive for 6+ months, removed from active inventory</p>
              </div>
              <button onClick={() => setShowArchive(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1 }}>×</button>
            </div>

            {/* Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: 0 }}>
              {archiveLoading && (
                <p style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>
              )}
              {archiveError && (
                <p style={{ padding: 40, textAlign: "center", color: "#c62828", fontSize: 13 }}>{archiveError}</p>
              )}
              {!archiveLoading && !archiveError && archiveRows.length === 0 && (
                <p style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>No archived vehicles for this dealer.</p>
              )}
              {archiveRows.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                      {["Stock #", "Year / Make / Model", "VIN", "Deactivated", "Archived", "Action"].map((h) => (
                        <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {archiveRows.map((r, i) => (
                      <tr key={r.id} style={{ borderBottom: i < archiveRows.length - 1 ? "1px solid var(--border)" : "none" }}>
                        <td style={{ padding: "8px 14px" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{r.stock_number}</span>
                        </td>
                        <td style={{ padding: "8px 14px" }}>
                          <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>{[r.year, r.make, r.model].filter(Boolean).join(" ") || "—"}</div>
                          {r.trim && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.trim}</div>}
                        </td>
                        <td style={{ padding: "8px 14px" }}>
                          <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)" }}>{r.vin ?? "—"}</span>
                        </td>
                        <td style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {r.updated_at ? new Date(r.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}
                        </td>
                        <td style={{ padding: "8px 14px", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                          {new Date(r.archived_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                        <td style={{ padding: "8px 14px" }}>
                          <button
                            onClick={() => handleRestore(r.id)}
                            disabled={restoringId === r.id}
                            style={{ height: 28, padding: "0 10px", fontSize: 11, fontWeight: 600, background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9", borderRadius: 4, cursor: restoringId === r.id ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
                          >
                            {restoringId === r.id ? "Restoring…" : "Restore"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <>
          <div onClick={() => setShowDeleteConfirm(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000 }} />
          <div style={{
            position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
            background: "#fff", borderRadius: 6, zIndex: 1001, width: "min(420px, 96vw)",
            padding: 24, boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
              Delete {checkedIds.size} vehicle{checkedIds.size !== 1 ? "s" : ""}?
            </h3>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              This cannot be undone. Print history will be preserved.
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowDeleteConfirm(false)} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
                Cancel
              </button>
              <button onClick={confirmBulkDelete} disabled={deleting} style={{ height: 36, padding: "0 16px", background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: deleting ? "not-allowed" : "pointer" }}>
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
      {/* Bulk print preview modal */}
      {bulkModal && (
        <PrintPreviewModal
          docType={bulkModal.docType}
          vehicleName={`${bulkModal.count} Vehicles`}
          preloadedUrl={bulkModal.url}
          onClose={() => setBulkModal(null)}
        />
      )}
    </div>
  );
}
