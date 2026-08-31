"use client";

import { useState, useEffect, useCallback } from "react";
import { formatOptionPrice } from "@/lib/option-price";
import type { AddendumLibraryRow } from "@/lib/db";
import { RichName } from "@/lib/product-name";
import ProductAuthoringFields from "@/components/ProductAuthoringFields";
import ProductRulesFields from "@/components/ProductRulesFields";
import ProductImportExport from "@/components/ProductImportExport";
import RulesInfoTip from "@/components/RulesInfoTip";
import Pager from "@/components/Pager";

// ── Types ──────────────────────────────────────────────────────────────────────

type FormData = {
  option_name: string;
  item_price: string;
  description: string;
  ad_types: string[];
  models: string;
  models_not: boolean;
  trims: string;
  trims_not: boolean;
  makes: string;
  makes_not: boolean;
  body_styles: string;
  fuel: string;
  fuel_not: boolean;
  year_condition: number;
  year_value: string;
  miles_condition: number;
  miles_value: string;
  msrp_condition: number;
  msrp1: string;
  msrp2: string;
  show_models_only: boolean;
  separator_above: boolean;
  separator_below: boolean;
  spaces: number;
  required: boolean;
};

const BLANK: FormData = {
  option_name: "", item_price: "", description: "", ad_types: ["New", "Used"],
  models: "", models_not: false, trims: "", trims_not: false,
  makes: "", makes_not: false, body_styles: "", fuel: "", fuel_not: false,
  year_condition: 0, year_value: "",
  miles_condition: 0, miles_value: "",
  msrp_condition: 0, msrp1: "", msrp2: "",
  show_models_only: false, separator_above: false, separator_below: false, spaces: 0,
  required: true,
};

function stripHtml(html: string): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

// Product names are stored as rich-text HTML (RichName + DOMPurify is the render
// gatekeeper), so a literal "&" is stored as "&amp;". The Edit form's Item Name
// input is a plain text field, so it must show the DECODED text ("Wear & Tear")
// not the raw HTML source ("Wear &amp; Tear"). Decode the common named/numeric
// entities; &amp; is decoded LAST (peels exactly one layer) so an already
// double-encoded value isn't collapsed further. The save path stores the field
// verbatim (no re-encode), so decode-on-read round-trips without accumulating
// entities. Any authored inline markup (<b>, colored <span>, <img>) carries no
// entities and is left intact for power-user editing.
function decodeNameEntities(s: string): string {
  if (!s) return "";
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function rowToForm(r: AddendumLibraryRow): FormData {
  return {
    option_name: decodeNameEntities(r.option_name), item_price: r.item_price, description: r.description,
    ad_types: r.ad_types && r.ad_types.length > 0 ? r.ad_types
      : r.ad_type === "New" ? ["New"]
      : r.ad_type === "Used" ? ["Used"]
      : ["New", "Used"],
    models: r.models, models_not: r.models_not,
    trims: r.trims, trims_not: r.trims_not,
    makes: r.makes, makes_not: r.makes_not,
    body_styles: r.body_styles,
    fuel: r.fuel ?? "", fuel_not: r.fuel_not ?? false,
    year_condition: r.year_condition, year_value: r.year_value != null ? String(r.year_value) : "",
    miles_condition: r.miles_condition, miles_value: r.miles_value != null ? String(r.miles_value) : "",
    msrp_condition: r.msrp_condition,
    msrp1: r.msrp1 != null ? String(r.msrp1) : "",
    msrp2: r.msrp2 != null ? String(r.msrp2) : "",
    show_models_only: r.show_models_only, separator_above: r.separator_above,
    separator_below: r.separator_below, spaces: r.spaces,
    required: r.required !== false,
  };
}

// ── Shared inline styles ───────────────────────────────────────────────────────

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4,
  fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff",
};
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase",
  letterSpacing: ".05em", display: "block", marginBottom: 5,
};
const btnPrimary: React.CSSProperties = {
  padding: "7px 16px", background: "#1976d2", color: "#fff", border: "none",
  borderRadius: 4, cursor: "pointer", fontSize: 13, fontWeight: 600,
};

// Shared pill-toggle style. Used for Product Type (Required/Suggested),
// Applies To (All/Rules/None), and Type (New/Used/CPO) — and mirrored in
// CorporateProductModal so the two product forms stay visually consistent.
// Convention: selected = blue (#1976d2 / #e3f2fd), unselected = white.
function pillToggleStyle(on: boolean): React.CSSProperties {
  return {
    flex: 1, padding: "7px 0", borderRadius: 4, fontWeight: 600, fontSize: 12,
    cursor: "pointer", fontFamily: "inherit",
    border: `2px solid ${on ? "#1976d2" : "#e0e0e0"}`,
    background: on ? "#e3f2fd" : "#fff",
    color: on ? "#1976d2" : "#55595c",
  };
}
const btnDanger: React.CSSProperties = {
  padding: "5px 10px", background: "#ff5252", color: "#fff", border: "none",
  borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const btnGhost: React.CSSProperties = {
  padding: "7px 14px", background: "#fff", color: "#55595c",
  border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13,
};

// ── Option form ────────────────────────────────────────────────────────────────

function OptionForm({
  form, setForm, appliesTo, setAppliesTo,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  appliesTo: "all" | "rules" | "none";
  setAppliesTo: (v: "all" | "rules" | "none") => void;
}) {
  function f(field: keyof FormData, value: unknown) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  const row = (label: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <label style={lbl}>{label}</label>
      {children}
    </div>
  );

  return (
    <div>
      {/* Item Name + Price + Description — shared with the group Corporate
          Product modal (components/ProductAuthoringFields). */}
      <ProductAuthoringFields
        itemName={form.option_name}
        price={form.item_price}
        description={form.description}
        onItemName={(v) => f("option_name", v)}
        onPrice={(v) => f("item_price", v)}
        onDescription={(v) => f("description", v)}
      />

      {/* Required vs Suggested — uses the shared blue=selected / white=unselected
          toggle convention. Keep CorporateProductModal's mirror in sync. */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Product Type</label>
        <div style={{ display: "flex", gap: 8 }}>
          {([
            { val: true,  label: "Required" },
            { val: false, label: "Suggested" },
          ] as const).map(({ val, label }) => {
            const on = form.required === val;
            return (
              <button type="button" key={label} onClick={() => f("required", val)}
                style={pillToggleStyle(on)}>
                {label}
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 11, color: "#78828c", marginTop: 6, marginBottom: 0 }}>
          {form.required
            ? "Required — dealer-installed item printed on the addendum (Required Products widget)."
            : "Suggested — optional upgrade offered to the buyer (Suggested Products widget)."}
        </p>
      </div>

      {/* Applies To toggle — shown before Type since it controls visibility */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Applies To</label>
        <div style={{ display: "flex", gap: 8 }}>
          {([["all", "All Vehicles"], ["rules", "Assign with Rules"], ["none", "No Vehicles"]] as const).map(([v, label]) => (
            <button type="button" key={v} onClick={() => setAppliesTo(v)}
              style={{
                flex: 1, padding: "7px 0", borderRadius: 4,
                border: `2px solid ${appliesTo === v ? "#1976d2" : "#e0e0e0"}`,
                background: appliesTo === v ? "#e3f2fd" : "#fff",
                color: appliesTo === v ? "#1976d2" : "#55595c",
                fontWeight: 600, fontSize: 12, cursor: "pointer",
              }}>
              {label}
            </button>
          ))}
        </div>
        {appliesTo === "none" && (
          <p style={{ fontSize: 11, color: "#78828c", marginTop: 6, marginBottom: 0 }}>
            This option will not auto-apply to any vehicle. It will appear in the &quot;+ From Library&quot; picker so dealers can add it manually.
          </p>
        )}
      </div>

      {/* Type — only shown when auto-applying (all or rules). Multi-select:
          each chosen condition shows blue (= on); unselected are white. */}
      {appliesTo !== "none" && row("Type", (
        <div style={{ display: "flex", gap: 8 }}>
          {(["New", "Used", "CPO"] as const).map((val) => {
            const on = form.ad_types.includes(val);
            return (
              <button type="button" key={val}
                onClick={() => {
                  const next = on
                    ? form.ad_types.length > 1 ? form.ad_types.filter(x => x !== val) : form.ad_types
                    : [...form.ad_types, val];
                  f("ad_types", next);
                }}
                style={pillToggleStyle(on)}>
                {val}
              </button>
            );
          })}
        </div>
      ))}

      {/* Rules section — only shown when "Assign with Rules". Shared with the
          group Corporate Product modal (components/ProductRulesFields) so the
          two rule UIs can't drift. */}
      {appliesTo === "rules" && (
        <ProductRulesFields
          value={form}
          onChange={(patch) => setForm(prev => ({ ...prev, ...patch }))}
        />
      )}

      {/* Always-visible bottom options */}
      <div style={{ borderTop: "1px solid #f0f0f0", paddingTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        {(["separator_above", "separator_below"] as const).map((field) => (
          <label key={field} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#333" }}>
            <input type="checkbox" checked={form[field]}
              onChange={e => f(field, e.target.checked)}
              style={{ width: 14, height: 14 }} />
            {field === "separator_above" ? "Add separator above" : "Add separator below"}
          </label>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
          <label style={{ ...lbl, margin: 0, whiteSpace: "nowrap" }}>Spaces</label>
          <input type="number" value={form.spaces} min={0} max={10}
            onChange={e => f("spaces", parseInt(e.target.value) || 0)}
            style={{ ...inp, width: 70 }} />
        </div>
      </div>
    </div>
  );
}

// ── Modal ──────────────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
      <div style={{ background: "#fff", borderRadius: 8, width: 680, maxWidth: "96vw", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: "16px 24px", borderBottom: "1px solid #e0e0e0", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#333" }}>{title}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: "#78828c", lineHeight: 1 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>{children}</div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 10, flexShrink: 0 }}>{footer}</div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OptionsLibrary({ dealerId }: { dealerId: string }) {
  const [items, setItems] = useState<AddendumLibraryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reorderMode, setReorderMode] = useState(false);
  const [reorderItems, setReorderItems] = useState<AddendumLibraryRow[]>([]);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);

  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState<AddendumLibraryRow | null>(null);
  const [form, setForm] = useState<FormData>(BLANK);
  const [appliesTo, setAppliesTo] = useState<"all" | "rules" | "none">("all");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Bulk selection (dealer-owned rows only — corporate products are locked)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Corporate products inherited from the dealer's parent group. Read-only on
  // the dealer side — the group admin manages them from the Group page. Empty
  // array when the dealer isn't in a group or no products apply to them.
  type CorporateProduct = {
    id: string;
    option_name: string;
    option_price: string;
    description: string | null;
    sort_order: number;
    required: boolean;
  } & import("@/lib/rule-summary").RuleSummaryRow;
  const [corporate, setCorporate] = useState<CorporateProduct[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dealers/${encodeURIComponent(dealerId)}/corporate-products`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then((j: { data?: CorporateProduct[] }) => { if (!cancelled) setCorporate(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [dealerId]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ dealer_id: dealerId, page: String(page), per_page: String(perPage) });
      const res = await fetch(`/api/addendum-library?${params}`);
      const json = await res.json() as { data?: AddendumLibraryRow[]; total?: number; error?: string };
      if (!res.ok) { setError(json.error ?? "Failed to load options"); return; }
      setItems(json.data ?? []);
      setTotal(json.total ?? 0);
      // Selection only ever holds rows visible on the current page — prune
      // anything that no longer exists after a refetch / page change.
      setSelected(prev => {
        const visible = new Set((json.data ?? []).map(d => d.id));
        const next = new Set(Array.from(prev).filter(id => visible.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [dealerId, page, perPage]);

  useEffect(() => { void fetchItems(); }, [fetchItems]);

  function openAdd() {
    setEditItem(null);
    setForm(BLANK);
    setAppliesTo("all");
    setFormError(null);
    setShowModal(true);
  }

  function openEdit(item: AddendumLibraryRow) {
    setEditItem(item);
    setForm(rowToForm(item));
    if (item.applies_to === "none") {
      setAppliesTo("none");
    } else {
      const hasRules = !!(item.models || item.trims || item.makes || item.body_styles || item.fuel || item.year_condition || item.miles_condition || item.msrp_condition);
      setAppliesTo(hasRules ? "rules" : "all");
    }
    setFormError(null);
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.option_name.trim()) { setFormError("Item Name is required."); return; }
    setSaving(true);
    setFormError(null);
    try {
      const base = {
        ...form,
        option_name: form.option_name.trim(),
        dealer_id: dealerId,
        year_value: form.year_value ? parseInt(form.year_value) : null,
        miles_value: form.miles_value ? parseInt(form.miles_value) : null,
        msrp1: form.msrp1 ? parseInt(form.msrp1) : null,
        msrp2: form.msrp2 ? parseInt(form.msrp2) : null,
        required: form.required,
      };
      const clearRules = { models: "", models_not: false, trims: "", trims_not: false, makes: "", makes_not: false, body_styles: "", fuel: "", fuel_not: false, year_condition: 0, year_value: null, miles_condition: 0, miles_value: null, msrp_condition: 0, msrp1: null, msrp2: null, show_models_only: false };
      const payload = appliesTo === "rules"
        ? { ...base, applies_to: "rules" }
        : { ...base, ...clearRules, applies_to: appliesTo };
      const url = editItem ? `/api/addendum-library/${editItem.id}` : "/api/addendum-library";
      const method = editItem ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json() as { error?: string };
      if (!res.ok) { setFormError(json.error ?? "Save failed"); return; }
      setShowModal(false);
      void fetchItems();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/addendum-library/${id}`, { method: "DELETE" });
    if (res.ok) { setDeleteConfirm(null); void fetchItems(); }
  }

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected(prev =>
      prev.size === items.length ? new Set<string>() : new Set(items.map(i => i.id))
    );
  }

  async function handleBulkDelete() {
    if (selected.size === 0) return;
    setBulkDeleting(true);
    try {
      const res = await fetch("/api/addendum-library/bulk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        setError(json.error ?? "Bulk delete failed");
        return;
      }
      const deletedAll = selected.size === items.length;
      setSelected(new Set());
      setBulkConfirm(false);
      // If the whole page was deleted, step back a page (triggers refetch);
      // otherwise refetch in place.
      if (deletedAll && page > 1) setPage(p => p - 1);
      else void fetchItems();
    } finally {
      setBulkDeleting(false);
    }
  }

  function enterReorder() {
    setReorderItems([...items]);
    setSelected(new Set());
    setReorderMode(true);
  }

  function cancelReorder() {
    setReorderMode(false);
    setDraggedIdx(null);
    setDragOverIdx(null);
  }

  async function saveOrder() {
    setSavingOrder(true);
    try {
      await fetch("/api/addendum-library/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId, order: reorderItems.map(r => r.id) }),
      });
      setReorderMode(false);
      void fetchItems();
    } finally {
      setSavingOrder(false);
    }
  }

  const displayItems = reorderMode ? reorderItems : items;
  const totalPages = Math.ceil(total / perPage);

  // ── Helper renderers ──

  function adTypeBadge(item: AddendumLibraryRow) {
    if (item.applies_to === "none") {
      return (
        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#fff3e0", color: "#e65100" }}>Manual Only</span>
      );
    }
    const styles: Record<string, React.CSSProperties> = {
      New:  { background: "#e8f5e9", color: "#2e7d32" },
      Used: { background: "#e3f2fd", color: "#1565c0" },
      CPO:  { background: "#fff3e0", color: "#e65100" },
    };
    const types: string[] = item.ad_types && item.ad_types.length > 0
      ? item.ad_types
      : item.ad_type === "New" ? ["New"]
      : item.ad_type === "Used" ? ["Used"]
      : ["New", "Used"];
    return (
      <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {types.map(t => (
          <span key={t} style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, ...(styles[t] ?? { background: "#f5f6f7", color: "#55595c" }) }}>{t}</span>
        ))}
      </span>
    );
  }

  function listPreview(val: string, not: boolean) {
    if (!val) return <span style={{ color: "#bbb", fontSize: 11 }}>ALL</span>;
    const items = val.split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
    const more = val.split(",").length > 3;
    return (
      <span style={{ fontSize: 11, color: "#333" }}>
        {not && <span style={{ color: "#ff5252", fontWeight: 700, marginRight: 4 }}>NOT</span>}
        {items.join(", ")}{more ? "…" : ""}
      </span>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, color: "#fff", margin: 0 }}>Addendum Products</h1>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,0.7)", marginTop: 4, marginBottom: 0 }}>
            {total > 0 ? `${total} product${total !== 1 ? "s" : ""}` : "Define products that auto-apply to vehicle addendums"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!reorderMode ? (
            <>
              <button onClick={enterReorder} disabled={items.length < 2}
                style={{ ...btnGhost, background: "#fff", color: "#333" }}>
                ⇅ Re-order
              </button>
              <ProductImportExport
                endpoint={`/api/addendum-library/sheet?dealer_id=${encodeURIComponent(dealerId)}`}
                onImported={() => void fetchItems()}
              />
              <button onClick={openAdd}
                style={{ ...btnPrimary, background: "#4caf50", border: "none", display: "flex", alignItems: "center", gap: 5 }}>
                + Add Product
              </button>
            </>
          ) : (
            <>
              <button onClick={cancelReorder} style={btnGhost}>Cancel</button>
              <button onClick={() => void saveOrder()} disabled={savingOrder}
                style={{ ...btnPrimary, background: "#4caf50" }}>
                {savingOrder ? "Saving…" : "Save Order"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Corporate products inherited from the parent group (read-only). */}
      {corporate.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
          <div style={{ padding: "10px 16px", background: "#e8eaf6", borderBottom: "1px solid #c5cae9", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14 }}>🔒</span>
            <p style={{ fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "#283593", margin: 0 }}>
              Corporate Products ({corporate.length})
            </p>
            <span style={{ fontSize: 11, color: "#5c6bc0" }}>
              Locked — managed by your group admin. Auto-applied to every printed addendum.
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f5f6f7", borderBottom: "1px solid #e0e0e0" }}>
                  <th style={th}>Product Name</th>
                  <th style={th}>Description</th>
                  <th style={th}>Type</th>
                  <th style={{ ...th, textAlign: "right" }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {corporate.map((c, i) => (
                  <tr key={c.id} style={{ borderBottom: i < corporate.length - 1 ? "1px solid var(--border)" : "none", background: "#f8f9ff" }}>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <RichName name={c.option_name} imgMaxH={24} showLabel style={{ fontWeight: 600, color: "#1a237e" }} />
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 10, background: "#e3f2fd", color: "#0d47a1", border: "1px solid #bbdefb" }}>
                          Group
                        </span>
                        <RulesInfoTip row={c} />
                      </div>
                    </td>
                    <td style={{ ...td, color: "#78828c", fontSize: 12 }}>
                      {c.description ? stripHtml(c.description).slice(0, 50) + (stripHtml(c.description).length > 50 ? "…" : "") : "—"}
                    </td>
                    <td style={td}>
                      {c.required
                        ? <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32" }}>Required</span>
                        : <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#fff3e0", color: "#e65100" }}>Suggested</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: "#1a237e" }}>
                      {formatOptionPrice(c.option_price)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden" }}>
        {error && (
          <div style={{ padding: "12px 20px", background: "#ffebee", color: "#c62828", fontSize: 13 }}>{error}</div>
        )}

        {loading && !items.length ? (
          <div style={{ padding: 40, textAlign: "center", color: "#78828c", fontSize: 13 }}>Loading options…</div>
        ) : !displayItems.length ? (
          <div style={{ padding: 48, textAlign: "center" }}>
            <div style={{ fontSize: 32, color: "#e0e0e0", marginBottom: 10 }}>☰</div>
            <div style={{ fontSize: 14, color: "#78828c", marginBottom: 16 }}>No products yet. Add your first product to get started.</div>
            <button onClick={openAdd} style={{ ...btnPrimary, background: "#4caf50" }}>+ Add Product</button>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
              <thead>
                <tr style={{ background: "#f5f6f7", borderBottom: "1px solid #e0e0e0" }}>
                  {reorderMode && <th style={{ width: 40, padding: "10px 8px" }} />}
                  {!reorderMode && (
                    <th style={{ width: 36, padding: "10px 8px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        aria-label="Select all products"
                        checked={items.length > 0 && selected.size === items.length}
                        onChange={toggleSelectAll}
                        style={{ cursor: "pointer" }}
                      />
                    </th>
                  )}
                  <th style={th}>Product Name</th>
                  <th style={th}>Description</th>
                  <th style={th}>Type</th>
                  <th style={th}>New/Used</th>
                  <th style={th}>Model</th>
                  <th style={th}>Trim</th>
                  <th style={th}>Bodystyle</th>
                  <th style={{ ...th, textAlign: "right" }}>Price</th>
                  {!reorderMode && <th style={{ ...th, width: 90, textAlign: "center" }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {displayItems.map((item, idx) => {
                  const isDragging = draggedIdx === idx;
                  const isDragOver = dragOverIdx === idx;
                  return (
                    <tr
                      key={item.id}
                      draggable={reorderMode}
                      onDragStart={() => { setDraggedIdx(idx); }}
                      onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
                      onDrop={() => {
                        if (draggedIdx === null || draggedIdx === idx) return;
                        const next = [...reorderItems];
                        const [moved] = next.splice(draggedIdx, 1);
                        next.splice(idx, 0, moved);
                        setReorderItems(next);
                        setDraggedIdx(null);
                        setDragOverIdx(null);
                      }}
                      onDragEnd={() => { setDraggedIdx(null); setDragOverIdx(null); }}
                      style={{
                        borderBottom: "1px solid #e0e0e0",
                        background: isDragOver ? "#e3f2fd" : isDragging ? "#fffde7" : "#fff",
                        opacity: isDragging ? 0.6 : 1,
                        cursor: reorderMode ? "grab" : "default",
                      }}
                    >
                      {reorderMode && (
                        <td style={{ padding: "8px 8px", textAlign: "center", color: "#bbb", fontSize: 18 }}>⠿</td>
                      )}
                      {!reorderMode && (
                        <td style={{ padding: "8px 8px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${stripHtml(item.option_name)}`}
                            checked={selected.has(item.id)}
                            onChange={() => toggleSelected(item.id)}
                            style={{ cursor: "pointer" }}
                          />
                        </td>
                      )}
                      <td style={td}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <RichName name={item.option_name} imgMaxH={24} showLabel style={{ fontWeight: 600, color: "#333", fontSize: 13 }} />
                          <RulesInfoTip row={item} />
                        </span>
                      </td>
                      <td style={td}>
                        <span style={{ color: "#78828c", fontSize: 12 }}>
                          {(() => {
                            const plain = stripHtml(item.description ?? "");
                            if (!plain) return <span style={{ color: "#ccc" }}>—</span>;
                            return plain.length > 50 ? plain.slice(0, 50) + "…" : plain;
                          })()}
                        </span>
                      </td>
                      <td style={td}>
                        {item.required !== false
                          ? <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#e8f5e9", color: "#2e7d32" }}>Required</span>
                          : <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: "#fff3e0", color: "#e65100" }}>Suggested</span>
                        }
                      </td>
                      <td style={td}>{adTypeBadge(item)}</td>
                      <td style={td}>{listPreview(item.models, item.models_not)}</td>
                      <td style={td}>{listPreview(item.trims, item.trims_not)}</td>
                      <td style={td}>
                        {item.body_styles
                          ? <span style={{ fontSize: 11, color: "#333" }}>{item.body_styles.split(",").slice(0, 2).join(", ")}{item.body_styles.split(",").length > 2 ? "…" : ""}</span>
                          : <span style={{ color: "#bbb", fontSize: 11 }}>ALL</span>}
                      </td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "monospace", fontWeight: 700, color: "#333", fontSize: 13 }}>
                        {formatOptionPrice(item.item_price)}
                      </td>
                      {!reorderMode && (
                        <td style={{ ...td, textAlign: "center" }}>
                          <div style={{ display: "flex", gap: 5, justifyContent: "center" }}>
                            <button onClick={() => openEdit(item)}
                              style={{ padding: "4px 10px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                              Edit
                            </button>
                            <button onClick={() => setDeleteConfirm(item.id)}
                              style={{ padding: "4px 8px", background: "#ff5252", color: "#fff", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                              ✕
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            </div>
            {/* Bulk action bar */}
            {!reorderMode && selected.size > 0 && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 20px", borderTop: "1px solid #e0e0e0", background: "#fff8f8" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>
                  ✓ {selected.size} selected
                </span>
                <button
                  onClick={() => setBulkConfirm(true)}
                  style={{ padding: "6px 16px", background: "#ff5252", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                >
                  Delete Selected ({selected.size})
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Pagination (shared centered Pager — keeps Next clear of corner overlays) */}
      {!reorderMode && displayItems.length > 0 && (
        <Pager page={page} totalPages={totalPages} onPage={setPage} light
          summary={
            <>
              <span style={{ fontSize: 12 }}>Rows per page:</span>
              <select value={perPage} onChange={e => { setPerPage(parseInt(e.target.value)); setPage(1); }}
                style={{ height: 28, padding: "0 6px", fontSize: 12, border: "1px solid rgba(255,255,255,0.25)", borderRadius: 4, background: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.8)", cursor: "pointer" }}>
                {[10, 25, 50].map(n => <option key={n} value={n} style={{ background: "#2a2b3c", color: "#fff" }}>{n}</option>)}
              </select>
              <span style={{ fontSize: 12 }}>
                {total > 0 ? `${(page - 1) * perPage + 1}–${Math.min(page * perPage, total)} of ${total}` : "0 results"}
              </span>
            </>
          } />
      )}

      {/* Add/Edit modal */}
      {showModal && (
        <Modal
          title={editItem ? "Edit Product" : "Configure Product"}
          onClose={() => setShowModal(false)}
          footer={
            <>
              {formError && <span style={{ fontSize: 12, color: "#ff5252", flex: 1 }}>{formError}</span>}
              <button onClick={() => setShowModal(false)} style={btnGhost}>Cancel</button>
              <button onClick={() => void handleSave()} disabled={saving} style={btnPrimary}>
                {saving ? "Saving…" : editItem ? "Save Changes" : "Add Product"}
              </button>
            </>
          }
        >
          <OptionForm
            form={form} setForm={setForm}
            appliesTo={appliesTo} setAppliesTo={setAppliesTo}
          />
        </Modal>
      )}

      {/* Delete confirm modal */}
      {deleteConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 8, padding: 28, width: 380, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#333", marginBottom: 10 }}>Delete Option?</div>
            <p style={{ fontSize: 13, color: "#55595c", marginBottom: 20 }}>This option will be permanently removed from your library. This cannot be undone.</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setDeleteConfirm(null)} style={btnGhost}>Cancel</button>
              <button onClick={() => void handleDelete(deleteConfirm)} style={btnDanger}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk delete confirm modal */}
      {bulkConfirm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: "#fff", borderRadius: 8, padding: 28, width: 380, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#333", marginBottom: 10 }}>
              Delete {selected.size} product{selected.size !== 1 ? "s" : ""}?
            </div>
            <p style={{ fontSize: 13, color: "#55595c", marginBottom: 20 }}>
              {selected.size !== 1 ? "These products" : "This product"} will be permanently removed from your library. This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setBulkConfirm(false)} style={btnGhost} disabled={bulkDeleting}>Cancel</button>
              <button onClick={() => void handleBulkDelete()} style={btnDanger} disabled={bulkDeleting}>
                {bulkDeleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

const th: React.CSSProperties = {
  padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 600,
  color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em",
};
const td: React.CSSProperties = {
  padding: "10px 14px", fontSize: 13, verticalAlign: "middle",
};
