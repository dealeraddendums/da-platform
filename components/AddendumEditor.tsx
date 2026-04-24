"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { VehicleRow } from "@/lib/vehicles";
import { vehicleCondition, parsePhotos } from "@/lib/vehicles";
import { formatOptionPrice, parseOptionPriceValue } from "@/lib/option-price";
import type { VehicleOptionRow } from "@/lib/db";
import PrintPreviewModal from "@/components/PrintPreviewModal";
import BuyersGuideModal from "@/components/BuyersGuideModal";

// ── Types ─────────────────────────────────────────────────────────────────────

type MatchedOption = {
  default_id?: number;
  option_name: string;
  option_price: string;
  description?: string | null;
  sort_order: number;
  source?: string;
};

type GroupOption = {
  id: string;
  option_name: string;
  option_price: string;
  sort_order: number;
  is_locked: true;
};

type LibraryOption = {
  default_id: number;
  option_name: string;
  option_price: string;
  description?: string | null;
  sort_order: number;
};

type Props = {
  vehicle: VehicleRow;
  dealerVehicleId: string;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AddendumEditor({ vehicle, dealerVehicleId }: Props) {
  const vehicleId = vehicle.id;
  const dealerId = vehicle.DEALER_ID;

  const [options, setOptions] = useState<(VehicleOptionRow | MatchedOption)[]>([]);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const [source, setSource] = useState<string>("loading");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Library picker
  const [showLibrary, setShowLibrary] = useState(false);
  const [library, setLibrary] = useState<LibraryOption[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [librarySearch, setLibrarySearch] = useState("");

  // Manual add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("NC");

  // Edit inline
  const [editingId, setEditingId] = useState<string | null>(null);

  // Print preview modal
  const [printDoc, setPrintDoc] = useState<"addendum" | "infosheet" | "buyer_guide" | null>(null);

  // Drag-and-drop
  const dragIdx = useRef<number | null>(null);

  // ── Fetch options ───────────────────────────────────────────────────────────

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/options/${vehicleId}`);
      const json = await res.json() as { data: (VehicleOptionRow | MatchedOption)[]; groupOptions?: GroupOption[]; source: string };
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Failed to load");
      setOptions(json.data ?? []);
      setGroupOptions(json.groupOptions ?? []);
      setSource(json.source);
      setDirty(json.source === "matched"); // matched defaults need a save
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error loading options");
    } finally {
      setLoading(false);
    }
  }, [vehicleId]);

  useEffect(() => {
    void fetchOptions();
  }, [fetchOptions]);

  // ── Library ─────────────────────────────────────────────────────────────────

  async function openLibrary() {
    setShowLibrary(true);
    if (library.length > 0) return;
    setLibraryLoading(true);
    try {
      let items: LibraryOption[];
      if (vehicleId === 0) {
        // Manual vehicle: read from Supabase addendum_library (auth-scoped, no dealer_id param)
        const res = await fetch("/api/addendum-library?per_page=100");
        const json = await res.json() as { data?: Array<{ option_name: string; item_price: string; sort_order: number }> };
        items = (json.data ?? []).map((r, i) => ({
          default_id: i,
          option_name: r.option_name,
          option_price: r.item_price,
          description: (r as { description?: string | null }).description ?? null,
          sort_order: r.sort_order,
        }));
      } else {
        const res = await fetch(`/api/options/library?dealer_id=${encodeURIComponent(dealerId)}`);
        const json = await res.json() as { data: LibraryOption[] };
        items = json.data ?? [];
      }
      setLibrary(items);
    } finally {
      setLibraryLoading(false);
    }
  }

  function addFromLibrary(opt: LibraryOption) {
    const next: MatchedOption = {
      default_id: opt.default_id,
      option_name: opt.option_name,
      option_price: opt.option_price,
      description: opt.description ?? null,
      sort_order: options.length,
      source: "default",
    };
    setOptions((prev) => [...prev, next]);
    setDirty(true);
    setShowLibrary(false);
    setLibrarySearch("");
  }

  // ── Add manual option ────────────────────────────────────────────────────────

  function submitAddForm(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const next: MatchedOption = {
      option_name: newName.trim(),
      option_price: newPrice.trim() || "NC",
      sort_order: options.length,
      source: "manual",
    };
    setOptions((prev) => [...prev, next]);
    setDirty(true);
    setNewName("");
    setNewPrice("NC");
    setShowAddForm(false);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  function deleteOption(idx: number) {
    setOptions((prev) => prev.filter((_, i) => i !== idx).map((o, i) => ({ ...o, sort_order: i })));
    setDirty(true);
  }

  // ── Drag-and-drop reorder ────────────────────────────────────────────────────

  function onDragStart(idx: number) {
    dragIdx.current = idx;
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIdx.current === null || dragIdx.current === idx) return;
    setOptions((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx.current!, 1);
      next.splice(idx, 0, moved);
      dragIdx.current = idx;
      return next.map((o, i) => ({ ...o, sort_order: i }));
    });
    setDirty(true);
  }

  function onDragEnd() {
    dragIdx.current = null;
  }

  // ── Inline edit ──────────────────────────────────────────────────────────────

  function updateOption(idx: number, field: "option_name" | "option_price", val: string) {
    setOptions((prev) =>
      prev.map((o, i) => (i === idx ? { ...o, [field]: val } : o))
    );
    setDirty(true);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function saveOptions() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/options/${vehicleId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          options: options.map((o, i) => ({
            option_name: o.option_name,
            option_price: o.option_price,
            description: (o as MatchedOption).description ?? (o as VehicleOptionRow).description ?? null,
            sort_order: i,
            source: o.source ?? "manual",
          })),
        }),
      });
      const json = await res.json() as { data?: VehicleOptionRow[] };
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Save failed");
      if (json.data) setOptions(json.data);
      setDirty(false);
      setSource("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // ── Print ─────────────────────────────────────────────────────────────────────

  async function handlePrint(docType: "addendum" | "infosheet" | "buyer_guide") {
    if (dirty) await saveOptions();
    setPrintDoc(docType);
  }

  // ── Totals ───────────────────────────────────────────────────────────────────

  const total = [...groupOptions, ...options].reduce((sum, o) => sum + parseOptionPriceValue(o.option_price), 0);
  const msrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  const askingPrice = msrp != null ? msrp + total : null;

  const cond = vehicleCondition(vehicle);
  const photos = parsePhotos(vehicle.PHOTOS ?? null);
  const appliedNames = new Set(options.map(o => o.option_name.toLowerCase().trim()));
  const filteredLibrary = library.filter(
    (o) =>
      !appliedNames.has(o.option_name.toLowerCase().trim()) &&
      (!librarySearch || o.option_name.toLowerCase().includes(librarySearch.toLowerCase()))
  );

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start", minHeight: 600 }}>

      {/* ── Left: Vehicle card ────────────────────────────────────────────── */}
      <div className="card" style={{ width: 220, flexShrink: 0, overflow: "hidden" }}>
        {photos[0] && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photos[0]}
            alt=""
            style={{ width: "100%", height: 140, objectFit: "cover", display: "block" }}
          />
        )}
        <div className="p-4">
          <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
            {[vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ")}
          </div>
          {vehicle.TRIM && (
            <div className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{vehicle.TRIM}</div>
          )}

          <div className="mt-3 space-y-1.5">
            <InfoRow label="VIN" value={vehicle.VIN_NUMBER} mono />
            {vehicle.STOCK_NUMBER && <InfoRow label="Stock" value={`#${vehicle.STOCK_NUMBER}`} mono />}
            <InfoRow label="Condition" value={cond} />
            {vehicle.EXT_COLOR && <InfoRow label="Color" value={vehicle.EXT_COLOR} />}
            {vehicle.MILEAGE && (
              <InfoRow label="Miles" value={parseInt(vehicle.MILEAGE, 10).toLocaleString()} />
            )}
            {msrp != null && (
              <InfoRow label="MSRP" value={`$${msrp.toLocaleString()}`} />
            )}
          </div>
        </div>
      </div>

      {/* ── Center: Options table ─────────────────────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="card" style={{ overflow: "hidden" }}>
          {/* Header */}
          <div
            className="px-4 py-3 flex items-center justify-between"
            style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}
          >
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Options
              {source === "matched" && (
                <span
                  className="ml-2 font-normal text-xs"
                  style={{ color: "var(--blue)", textTransform: "none", letterSpacing: 0 }}
                >
                  (auto-matched defaults — save to confirm)
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn btn-secondary text-xs"
                style={{ height: 28, padding: "0 10px" }}
                onClick={() => void openLibrary()}
              >
                + From Library
              </button>
              <button
                type="button"
                className="btn btn-secondary text-xs"
                style={{ height: 28, padding: "0 10px" }}
                onClick={() => setShowAddForm(true)}
              >
                + Custom
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="px-4 py-2 text-xs" style={{ background: "#ffebee", color: "var(--error)" }}>
              {error}
            </div>
          )}

          {/* Loading */}
          {loading ? (
            <div className="p-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading options…</div>
          ) : groupOptions.length === 0 && options.length === 0 ? (
            <div className="p-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>
              No options yet. Add from the library or create a custom option.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  <th className="px-3 py-2 text-left" style={{ width: 28, color: "var(--text-muted)", fontSize: 11 }}></th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>Option</th>
                  <th className="px-3 py-2 text-right font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", width: 110 }}>Price</th>
                  <th className="px-3 py-2" style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {/* Locked group options at top */}
                {groupOptions.map((opt) => (
                  <tr
                    key={`group-${opt.id}`}
                    style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}
                  >
                    <td className="px-3 py-2 text-center" style={{ color: "#1565c0", fontSize: 13 }}>
                      🔒
                    </td>
                    <td className="px-3 py-2">
                      <span style={{ color: "var(--text-secondary)" }}>{opt.option_name}</span>
                      <span
                        className="ml-2 text-xs px-1.5 py-0.5 rounded"
                        style={{ background: "#e3f2fd", color: "#1565c0", fontSize: 10, fontWeight: 600 }}
                      >
                        Group
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
                        {formatOptionPrice(opt.option_price)}
                      </span>
                    </td>
                    <td className="px-3 py-2"></td>
                  </tr>
                ))}

                {/* Dealer editable options */}
                {options.map((opt, idx) => {
                  const id = (opt as VehicleOptionRow).id ?? `idx-${idx}`;
                  const isEditing = editingId === String(id);
                  return (
                    <tr
                      key={id}
                      draggable
                      onDragStart={() => onDragStart(idx)}
                      onDragOver={(e) => onDragOver(e, idx)}
                      onDragEnd={onDragEnd}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        cursor: "grab",
                        background: isEditing ? "var(--bg-subtle)" : undefined,
                      }}
                    >
                      {/* Drag handle */}
                      <td className="px-3 py-2 text-center" style={{ color: "var(--text-muted)", cursor: "grab" }}>
                        ⠿
                      </td>

                      {/* Name + description */}
                      <td className="px-3 py-2">
                        {isEditing ? (
                          <input
                            autoFocus
                            className="input text-sm"
                            style={{ height: 28, width: "100%" }}
                            value={opt.option_name}
                            onChange={(e) => updateOption(idx, "option_name", e.target.value)}
                            onBlur={() => setEditingId(null)}
                          />
                        ) : (
                          <div>
                            <span
                              style={{ color: "var(--text-primary)", cursor: "text" }}
                              onClick={() => setEditingId(String(id))}
                            >
                              {opt.option_name}
                            </span>
                            {(() => {
                              const desc = (opt as MatchedOption).description ?? (opt as VehicleOptionRow).description;
                              return desc ? (
                                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, paddingLeft: 8, lineHeight: 1.4 }}>
                                  {desc}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        )}
                      </td>

                      {/* Price */}
                      <td className="px-3 py-2 text-right">
                        {isEditing ? (
                          <input
                            className="input text-sm text-right"
                            style={{ height: 28, width: 90 }}
                            value={opt.option_price}
                            onChange={(e) => updateOption(idx, "option_price", e.target.value)}
                            onBlur={() => setEditingId(null)}
                          />
                        ) : (
                          <span
                            className="font-medium"
                            style={{ color: "var(--text-primary)", cursor: "text" }}
                            onClick={() => setEditingId(String(id))}
                          >
                            {formatOptionPrice(opt.option_price)}
                          </span>
                        )}
                      </td>

                      {/* Delete */}
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => deleteOption(idx)}
                          style={{ color: "var(--text-muted)", fontSize: 16, lineHeight: 1 }}
                          title="Remove"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Add form */}
          {showAddForm && (
            <form
              onSubmit={submitAddForm}
              className="px-4 py-3 flex items-center gap-2"
              style={{ borderTop: "1px solid var(--border)", background: "var(--bg-subtle)" }}
            >
              <input
                autoFocus
                className="input text-sm flex-1"
                style={{ height: 32 }}
                placeholder="Option name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <input
                className="input text-sm"
                style={{ height: 32, width: 90 }}
                placeholder="NC"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
              />
              <button type="submit" className="btn btn-primary text-xs" style={{ height: 32 }}>
                Add
              </button>
              <button
                type="button"
                className="btn btn-secondary text-xs"
                style={{ height: 32 }}
                onClick={() => setShowAddForm(false)}
              >
                Cancel
              </button>
            </form>
          )}

          {/* Totals */}
          {options.length > 0 && (
            <div
              className="px-4 py-3"
              style={{ borderTop: "2px solid var(--border)", background: "var(--bg-subtle)" }}
            >
              {total > 0 && (
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "var(--text-secondary)" }}>Options Total</span>
                  <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                    ${total.toLocaleString()}
                  </span>
                </div>
              )}
              {msrp != null && (
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "var(--text-secondary)" }}>MSRP</span>
                  <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                    ${msrp.toLocaleString()}
                  </span>
                </div>
              )}
              {askingPrice != null && total > 0 && (
                <div className="flex justify-between text-sm font-semibold" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4 }}>
                  <span style={{ color: "var(--text-primary)" }}>Asking Price</span>
                  <span style={{ color: "var(--blue)" }}>
                    ${askingPrice.toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Save button */}
        {dirty && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void saveOptions()}
            >
              {saving ? "Saving…" : "Save Options"}
            </button>
          </div>
        )}
      </div>

      {/* ── Right: Print actions ──────────────────────────────────────────── */}
      <div style={{ width: 180, flexShrink: 0 }}>
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
            Create Document
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="btn btn-primary w-full text-sm"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => setPrintDoc("addendum")}
            >
              Addendum
            </button>
            <button
              type="button"
              className="btn btn-secondary w-full text-sm"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => setPrintDoc("infosheet")}
            >
              Info Sheet
            </button>
            <button
              type="button"
              className="btn btn-secondary w-full text-sm"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => setPrintDoc("buyer_guide")}
            >
              Buyer Guide
            </button>
          </div>
          <div className="mt-4 pt-4" style={{ borderTop: "1px solid var(--border)" }}>
            <a
              href={`/vehicles/${vehicleId}/history`}
              className="text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              View print history →
            </a>
          </div>
        </div>
      </div>

      {/* ── Library picker modal ──────────────────────────────────────────── */}
      {showLibrary && (
        <Modal title="Add from Library" onClose={() => setShowLibrary(false)}>
          <div className="px-4 pb-2 pt-1">
            <input
              className="input text-sm w-full"
              style={{ height: 34 }}
              placeholder="Search options…"
              value={librarySearch}
              onChange={(e) => setLibrarySearch(e.target.value)}
              autoFocus
            />
          </div>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            {libraryLoading ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>
            ) : filteredLibrary.length === 0 ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>No options found.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {filteredLibrary.map((opt) => (
                    <tr
                      key={opt.default_id}
                      style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                      onClick={() => addFromLibrary(opt)}
                    >
                      <td className="px-4 py-2.5" style={{ color: "var(--text-primary)" }}>{opt.option_name}</td>
                      <td className="px-4 py-2.5 text-right font-medium" style={{ color: "var(--text-secondary)", width: 90 }}>
                        {formatOptionPrice(opt.option_price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}

      {/* ── Print preview modal ───────────────────────────────────────────── */}
      {printDoc && printDoc !== 'buyer_guide' && (
        <PrintPreviewModal
          dealerVehicleId={dealerVehicleId}
          docType={printDoc}
          vehicleName={[vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ") || "Vehicle"}
          onClose={() => setPrintDoc(null)}
        />
      )}
      {printDoc === 'buyer_guide' && (
        <BuyersGuideModal
          dealerVehicleId={dealerVehicleId}
          vehicleName={[vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ") || "Vehicle"}
          onClose={() => setPrintDoc(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{label}</span>
      <span
        style={{
          color: "var(--text-secondary)",
          fontFamily: mono ? "monospace" : undefined,
          fontSize: mono ? 11 : undefined,
          textAlign: "right",
          wordBreak: "break-all",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          width: 480, maxWidth: "90vw", maxHeight: "80vh",
          display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          overflow: "hidden",
        }}
      >
        {/* Modal header */}
        <div
          className="px-4 py-3 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--border)", flexShrink: 0 }}
        >
          <span className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            style={{ fontSize: 20, color: "var(--text-muted)", lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <div style={{ overflow: "auto" }}>{children}</div>
      </div>
    </div>
  );
}
