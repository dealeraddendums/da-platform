"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { VehicleRow } from "@/lib/vehicles";
import { vehicleCondition, parsePhotos } from "@/lib/vehicles";
import { formatOptionPrice, parseOptionPriceValue, priceSetUsesDecimals, formatCurrencyAmount } from "@/lib/option-price";
import { RichName, sanitizeProductDescription } from "@/lib/product-name";
import type { VehicleOptionRow } from "@/lib/db";
import PrintPreviewModal from "@/components/PrintPreviewModal";
import BuyersGuideModal from "@/components/BuyersGuideModal";
import RichTextEditor from "@/components/RichTextEditor";

// ── Types ─────────────────────────────────────────────────────────────────────

type MatchedOption = {
  default_id?: number;
  option_name: string;
  option_price: string;
  description?: string | null;
  sort_order: number;
  source?: string;
  required?: boolean;
};

type GroupOption = {
  id: string;
  option_name: string;
  option_price: string;
  description?: string | null;
  sort_order: number;
  required?: boolean;
  is_locked: true;
  /** Per-product lock (migration 063). When false, dealer can dismiss
   *  this product on this specific vehicle without affecting others. */
  locked?: boolean;
};

type LibraryOption = {
  default_id: number;
  option_name: string;
  option_price: string;
  description?: string | null;
  sort_order: number;
  required?: boolean;
};

type PrintState = {
  addendum: boolean;
  infosheet: boolean;
  buyer_guide: boolean;
  lastDate: string | null;
};

type Props = {
  vehicle: VehicleRow;
  dealerVehicleId: string;
  initialDocType?: "infosheet" | "buyer_guide";
  initialPrintState?: PrintState;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function AddendumEditor({ vehicle, dealerVehicleId, initialDocType, initialPrintState }: Props) {
  // Use UUID for manual vehicles (vehicle.id===0) so options are saved per-vehicle, not shared
  const vehicleId: string | number = vehicle.id === 0 ? dealerVehicleId : vehicle.id;
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

  // Per-vehicle product edit modal (this vehicle only — global library untouched)
  const [editProduct, setEditProduct] = useState<
    { idx: number; name: string; price: string; description: string; required: boolean } | null
  >(null);

  // Print preview modal — initialize with initialDocType so ?type= param auto-opens correct modal
  const [printDoc, setPrintDoc] = useState<"addendum" | "infosheet" | "buyer_guide" | null>(
    initialDocType ?? null
  );

  // Per-document print state, seeded from server props. Updated optimistically
  // when a print runs so the button color reflects "this dealer just printed
  // it" without a page reload.
  const [printState, setPrintState] = useState<PrintState>(initialPrintState ?? {
    addendum: false, infosheet: false, buyer_guide: false, lastDate: null,
  });

  function todayIso(): string { return new Date().toISOString().split("T")[0]; }
  function formatPrintDate(d: string | null): string {
    if (!d) return "";
    return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

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

  async function dismissGroupOption(groupOptionId: string) {
    // Remove an unlocked corporate product from this specific vehicle.
    // The product stays in the group library and on other vehicles —
    // see /api/options/[vehicleId]/dismiss-group-option for the
    // server-side guard against dismissing locked products.
    const res = await fetch(`/api/options/${vehicleId}/dismiss-group-option`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupOptionId }),
    });
    if (res.ok) {
      setGroupOptions(prev => prev.filter(g => g.id !== groupOptionId));
    } else {
      const j = await res.json().catch(() => ({})) as { error?: string };
      // Surface a minimal alert — the only realistic failure is the server
      // refusing because the product is actually locked.
      alert(j.error ?? "Failed to remove product");
    }
  }

  async function openLibrary() {
    setShowLibrary(true);
    if (library.length > 0) return;
    setLibraryLoading(true);
    try {
      let items: LibraryOption[];
      if (typeof vehicleId === "string" && vehicleId.includes("-")) {
        // Manual vehicle (UUID): read from Supabase addendum_library (auth-scoped, no dealer_id param)
        const res = await fetch("/api/addendum-library?per_page=100");
        const json = await res.json() as { data?: Array<{ option_name: string; item_price: string; sort_order: number; description?: string | null; required?: boolean }> };
        items = (json.data ?? []).map((r, i) => ({
          default_id: i,
          option_name: r.option_name,
          option_price: r.item_price,
          description: r.description ?? null,
          sort_order: r.sort_order,
          required: r.required,
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
      required: opt.required,
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

  // ── Per-vehicle product edit ─────────────────────────────────────────────────
  // Opens the product modal pre-filled with this line's values; saving updates
  // only THIS vehicle's vehicle_options row (replace-all via POST), never the
  // global addendum_library product.

  function openEditProduct(idx: number) {
    const o = options[idx];
    setEditProduct({
      idx,
      name: o.option_name,
      price: o.option_price,
      description: (o as MatchedOption).description ?? (o as VehicleOptionRow).description ?? "",
      required: (o as MatchedOption).required !== false && (o as VehicleOptionRow).required !== false,
    });
  }

  async function saveEditProduct() {
    if (!editProduct) return;
    const { idx, name, price, description, required } = editProduct;
    if (!name.trim()) return;
    // Drop an empty rich-text shell (e.g. "<p></p>") to null so it renders nothing.
    const descClean =
      description && (description.replace(/<[^>]*>/g, "").trim() !== "" || /<img/i.test(description))
        ? description
        : null;
    const updated = options.map((o, i) =>
      i === idx
        ? { ...o, option_name: name.trim(), option_price: price.trim() || "NC", description: descClean, required }
        : o
    );
    setOptions(updated);
    setDirty(true);
    setEditProduct(null);
    await saveOptions(updated);
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

  function toggleRequired(idx: number) {
    setOptions((prev) =>
      prev.map((o, i) => {
        if (i !== idx) return o;
        const cur = (o as MatchedOption).required !== false;
        return { ...o, required: !cur };
      })
    );
    setDirty(true);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function saveOptions(override?: (VehicleOptionRow | MatchedOption)[]) {
    const list = override ?? options;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/options/${vehicleId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          options: list.map((o, i) => ({
            option_name: o.option_name,
            option_price: o.option_price,
            description: (o as MatchedOption).description ?? (o as VehicleOptionRow).description ?? null,
            sort_order: i,
            source: o.source ?? "manual",
            required: (o as MatchedOption).required !== false && (o as VehicleOptionRow).required !== false,
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

  // ── Print — always saves current options before generating PDF ───────────────

  async function handlePrint(docType: "addendum" | "infosheet" | "buyer_guide") {
    await saveOptions();
    setPrintDoc(docType);
  }

  // ── Totals ───────────────────────────────────────────────────────────────────

  const reqOptions = options.filter(o => (o as MatchedOption).required !== false && (o as VehicleOptionRow).required !== false);
  const sugOptions = options.filter(o => (o as MatchedOption).required === false || (o as VehicleOptionRow).required === false);
  // Group options carry their own required flag; only Required ones go into the
  // Asking Price math, Suggested locked-assignments fall into the Suggested total.
  const reqGroup = groupOptions.filter(g => g.required !== false);
  const sugGroup = groupOptions.filter(g => g.required === false);
  const reqTotal = [...reqGroup, ...reqOptions].reduce((sum, o) => sum + parseOptionPriceValue(o.option_price), 0);
  const sugTotal = [...sugGroup, ...sugOptions].reduce((sum, o) => sum + parseOptionPriceValue(o.option_price), 0);
  const total = reqTotal + sugTotal;
  const msrp = vehicle.MSRP ? parseFloat(vehicle.MSRP) : null;
  const askingPrice = msrp != null ? msrp + reqTotal : null;
  const suggestedAskingPrice = sugTotal > 0 && msrp != null ? msrp + reqTotal + sugTotal : null;

  // Shared decimals policy — match pdf-html.ts so the UI stays WYSIWYG.
  // If any price (product, subtotal, MSRP, asking, suggested) has cents,
  // render every label with two decimals; otherwise drop them everywhere.
  const decimals = priceSetUsesDecimals([
    msrp,
    reqTotal,
    sugTotal,
    askingPrice,
    suggestedAskingPrice,
    ...[...reqGroup, ...reqOptions, ...sugGroup, ...sugOptions].map(o => parseOptionPriceValue(o.option_price)),
  ]);

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
              <InfoRow label="MSRP" value={formatCurrencyAmount(msrp, decimals)} />
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
              Addendum Details
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
              No products yet. Add from the library or create a custom product.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--bg-subtle)", borderBottom: "1px solid var(--border)" }}>
                  <th className="px-3 py-2 text-left" style={{ width: 28, color: "var(--text-muted)", fontSize: 11 }}></th>
                  <th className="px-3 py-2 text-left font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>Products</th>
                  <th className="px-3 py-2 text-right font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", width: 110 }}>Price</th>
                  <th className="px-3 py-2 text-center font-semibold" style={{ color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", width: 100 }}>Type</th>
                  <th className="px-3 py-2" style={{ width: 64 }}></th>
                </tr>
              </thead>
              <tbody>
                {/* Locked group options at top */}
                {groupOptions.map((opt) => {
                  const required = opt.required !== false;
                  // Unlocked corporate products can be dismissed on this
                  // specific vehicle. The lock icon flips and a remove (×)
                  // button appears, gated by the `locked` flag from the
                  // group_options row (migration 063).
                  const unlocked = opt.locked === false;
                  return (
                    <tr
                      key={`group-${opt.id}`}
                      style={{ borderBottom: "1px solid var(--border)", background: "#f8f9ff" }}
                    >
                      <td className="px-3 py-2 text-center" style={{ color: "#1565c0", fontSize: 13 }}>
                        {unlocked
                          ? "🔓"
                          : <span title="Contact your Group Administrator to make changes to this product">🔒</span>}
                      </td>
                      <td className="px-3 py-2">
                        <RichName name={opt.option_name} imgMaxH={28} showLabel style={{ color: "var(--text-secondary)" }} />
                        <span
                          className="ml-2 text-xs px-1.5 py-0.5 rounded"
                          style={{ background: "#e3f2fd", color: "#1565c0", fontSize: 10, fontWeight: 600 }}
                        >
                          Group
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className="font-medium" style={{ color: "var(--text-secondary)" }}>
                          {formatOptionPrice(opt.option_price, decimals)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        {required ? (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32" }}>Required</span>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10, background: "#fff3e0", color: "#e65100" }}>Suggested</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {unlocked && (
                          <button
                            type="button"
                            onClick={() => void dismissGroupOption(opt.id)}
                            title="Remove this product from this vehicle's addendum (group library is unaffected)"
                            style={{
                              background: "none", border: "none", color: "var(--text-muted)",
                              fontSize: 16, cursor: "pointer", padding: 4, lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}

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
                              <RichName name={opt.option_name} imgMaxH={28} showLabel />
                            </span>
                            {(() => {
                              const desc = (opt as MatchedOption).description ?? (opt as VehicleOptionRow).description;
                              if (!desc) return null;
                              // Route through the DESCRIPTION sanitizer so
                              // authored bullets / line breaks / font-size
                              // survive (the tight name allowlist collapsed
                              // them). The .description-html class re-applies
                              // list markers + indent that Tailwind preflight
                              // strips on-screen (globals.css), matching print.
                              return (
                                <div
                                  className="description-html"
                                  style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, paddingLeft: 8, lineHeight: 1.4 }}
                                  // eslint-disable-next-line react/no-danger
                                  dangerouslySetInnerHTML={{ __html: sanitizeProductDescription(desc) }}
                                />
                              );
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
                            {formatOptionPrice(opt.option_price, decimals)}
                          </span>
                        )}
                      </td>

                      {/* Required/Suggested toggle */}
                      <td className="px-3 py-2 text-center">
                        {(() => {
                          const isReq = (opt as MatchedOption).required !== false && (opt as VehicleOptionRow).required !== false;
                          return (
                            <button
                              type="button"
                              onClick={() => toggleRequired(idx)}
                              title={isReq ? "Click to mark as Suggested" : "Click to mark as Required"}
                              style={{
                                fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 10,
                                border: "none", cursor: "pointer",
                                background: isReq ? "#e8f5e9" : "#fff3e0",
                                color: isReq ? "#2e7d32" : "#e65100",
                              }}
                            >
                              {isReq ? "Required" : "Suggested"}
                            </button>
                          );
                        })()}
                      </td>

                      {/* Edit + Delete */}
                      <td className="px-3 py-2">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => openEditProduct(idx)}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 13, lineHeight: 1, cursor: "pointer" }}
                            title="Edit this product for this vehicle only"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteOption(idx)}
                            style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 16, lineHeight: 1, cursor: "pointer" }}
                            title="Remove"
                          >
                            ×
                          </button>
                        </div>
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
              {reqTotal > 0 && (
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "var(--text-secondary)" }}>Required Products</span>
                  <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                    {formatCurrencyAmount(reqTotal, decimals)}
                  </span>
                </div>
              )}
              {sugTotal > 0 && (
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "#e65100" }}>Suggested Products</span>
                  <span className="font-medium" style={{ color: "#e65100" }}>
                    {formatCurrencyAmount(sugTotal, decimals)}
                  </span>
                </div>
              )}
              {msrp != null && (
                <div className="flex justify-between text-sm mb-1">
                  <span style={{ color: "var(--text-secondary)" }}>MSRP</span>
                  <span className="font-medium" style={{ color: "var(--text-primary)" }}>
                    {formatCurrencyAmount(msrp, decimals)}
                  </span>
                </div>
              )}
              {askingPrice != null && reqTotal > 0 && (
                <div className="flex justify-between text-sm font-semibold" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 4 }}>
                  <span style={{ color: "var(--text-primary)" }}>Asking Price</span>
                  <span style={{ color: "var(--blue)" }}>
                    {formatCurrencyAmount(askingPrice, decimals)}
                  </span>
                </div>
              )}
              {suggestedAskingPrice != null && (
                <div className="flex justify-between text-sm" style={{ marginTop: 4 }}>
                  <span style={{ color: "#e65100", fontSize: 12 }}>+ w/ Suggestions</span>
                  <span style={{ color: "#e65100", fontSize: 12, fontWeight: 600 }}>
                    {formatCurrencyAmount(suggestedAskingPrice, decimals)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* ── Right: Print actions ──────────────────────────────────────────── */}
      <div style={{ width: 180, flexShrink: 0 }}>
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
            Create Document
          </p>
          <div className="flex flex-col gap-2">
            {(["addendum", "infosheet", "buyer_guide"] as const).map((dt) => {
              const label = dt === "addendum" ? "Addendum" : dt === "infosheet" ? "Info Sheet" : "Buyer Guide";
              const printed = printState[dt];
              const tooltip = printed && printState.lastDate
                ? `Last printed ${formatPrintDate(printState.lastDate)}`
                : undefined;
              const baseStyle: React.CSSProperties = {
                height: 36, padding: "0 14px",
                fontSize: 13, fontWeight: 600,
                borderRadius: 6, justifyContent: "flex-start", textAlign: "left",
                width: "100%", cursor: saving ? "default" : "pointer",
                display: "inline-flex", alignItems: "center",
              };
              const style: React.CSSProperties = printed
                ? { ...baseStyle, background: "#1976d2", color: "#fff", border: "1px solid #1565c0" }
                : { ...baseStyle, background: "#fff", color: "#333", border: "1px solid #c0c0c0" };
              return (
                <button
                  key={dt}
                  type="button"
                  title={tooltip}
                  style={style}
                  disabled={saving}
                  onClick={() => void handlePrint(dt)}
                >
                  {saving ? "Saving…" : label}
                </button>
              );
            })}
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
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>No products found.</div>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {filteredLibrary.map((opt) => (
                    <tr
                      key={opt.default_id}
                      style={{ borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                      onClick={() => addFromLibrary(opt)}
                    >
                      <td className="px-4 py-2.5" style={{ color: "var(--text-primary)" }}>
                        <RichName name={opt.option_name} imgMaxH={20} showLabel />
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium" style={{ color: "var(--text-secondary)", width: 90 }}>
                        {formatOptionPrice(opt.option_price, decimals)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Modal>
      )}

      {/* ── Per-vehicle product edit modal ────────────────────────────────── */}
      {editProduct && (
        <Modal title="Edit Product" onClose={() => setEditProduct(null)}>
          <div className="px-4 py-3" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              className="text-xs px-3 py-2 rounded"
              style={{ background: "#e3f2fd", color: "#1565c0", fontWeight: 600 }}
            >
              Editing for this vehicle only — does not change the global product.
            </div>

            <label style={{ display: "block" }}>
              <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Name</span>
              <input
                className="input text-sm w-full"
                style={{ height: 34, marginTop: 4 }}
                value={editProduct.name}
                onChange={(e) => setEditProduct((p) => (p ? { ...p, name: e.target.value } : p))}
                autoFocus
              />
            </label>

            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ flex: 1 }}>
                <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Price</span>
                <input
                  className="input text-sm w-full"
                  style={{ height: 34, marginTop: 4 }}
                  placeholder="NC"
                  value={editProduct.price}
                  onChange={(e) => setEditProduct((p) => (p ? { ...p, price: e.target.value } : p))}
                />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 18 }}>
                <input
                  type="checkbox"
                  checked={editProduct.required}
                  onChange={(e) => setEditProduct((p) => (p ? { ...p, required: e.target.checked } : p))}
                />
                <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Required</span>
              </label>
            </div>

            <div>
              <span className="text-xs font-semibold" style={{ color: "var(--text-muted)" }}>Description</span>
              <div style={{ marginTop: 4 }}>
                <RichTextEditor
                  value={editProduct.description}
                  onChange={(html) => setEditProduct((p) => (p ? { ...p, description: html } : p))}
                  placeholder="Optional description shown under the product name"
                  minHeight={80}
                  toolbarOpen
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn-secondary text-xs" style={{ height: 32 }} onClick={() => setEditProduct(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary text-xs"
                style={{ height: 32 }}
                disabled={saving || !editProduct.name.trim()}
                onClick={() => void saveEditProduct()}
              >
                {saving ? "Saving…" : "Save for this vehicle"}
              </button>
            </div>
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
          onPrinted={() => {
            const dt = printDoc;
            setPrintState(prev => ({
              ...prev,
              addendum: dt === 'addendum' ? true : prev.addendum,
              infosheet: dt === 'infosheet' ? true : prev.infosheet,
              lastDate: todayIso(),
            }));
          }}
        />
      )}
      {printDoc === 'buyer_guide' && (
        <BuyersGuideModal
          dealerVehicleId={dealerVehicleId}
          vehicleName={[vehicle.YEAR, vehicle.MAKE, vehicle.MODEL].filter(Boolean).join(" ") || "Vehicle"}
          onClose={() => setPrintDoc(null)}
          onPrinted={() => {
            setPrintState(prev => ({ ...prev, buyer_guide: true, lastDate: todayIso() }));
          }}
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
