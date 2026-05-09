"use client";

import { useEffect, useState } from "react";
import RichTextEditor from "@/components/RichTextEditor";
import type { GroupOptionRow } from "@/lib/db";

type DealerBasic = { id: string; name: string };

type FormState = {
  option_name: string;
  option_price: string;
  description: string;
  required: boolean;            // true = Required, false = Suggested
  applies_to: "all" | "rules" | "none";
  ad_types: string[];           // ["New","Used","CPO"]
  models: string;
  models_not: boolean;
  trims: string;
  trims_not: boolean;
  makes: string;
  makes_not: boolean;
  separator_above: boolean;
  separator_below: boolean;
  spaces: number;
};

const BLANK: FormState = {
  option_name: "",
  option_price: "NC",
  description: "",
  required: true,
  applies_to: "all",
  ad_types: ["New", "Used", "CPO"],
  models: "",
  models_not: false,
  trims: "",
  trims_not: false,
  makes: "",
  makes_not: false,
  separator_above: false,
  separator_below: false,
  spaces: 0,
};

function rowToForm(r: GroupOptionRow): FormState {
  const adTypes = (r.ad_types && r.ad_types.length > 0) ? r.ad_types : ["New", "Used", "CPO"];
  return {
    option_name: r.option_name ?? "",
    option_price: r.option_price ?? "NC",
    description: r.description ?? "",
    required: r.required ?? !(r.is_suggested ?? false),
    applies_to: (r.applies_to as "all" | "rules" | "none") ?? "all",
    ad_types: adTypes,
    models: r.models ?? "",
    models_not: r.models_not ?? false,
    trims: r.trims ?? "",
    trims_not: r.trims_not ?? false,
    makes: r.makes ?? "",
    makes_not: r.makes_not ?? false,
    separator_above: r.separator_above ?? false,
    separator_below: r.separator_below ?? false,
    spaces: r.spaces ?? 0,
  };
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", height: 36,
  border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff",
  fontSize: 13, color: "#333",
};
const lbl: React.CSSProperties = {
  display: "block", fontSize: 11, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: "0.05em", color: "#78828c", marginBottom: 5,
};

function TypePill({ active, color, bg, border, label, onClick }: {
  active: boolean; color: string; bg: string; border: string; label: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, padding: "8px 0", borderRadius: 4, fontWeight: 600, fontSize: 13, cursor: "pointer",
        border: `2px solid ${active ? border : "#e0e0e0"}`,
        background: active ? bg : "#fff",
        color: active ? color : "#55595c",
      }}
    >
      {label}
    </button>
  );
}

export default function CorporateProductModal({
  groupId,
  initial,
  onClose,
  onSaved,
}: {
  groupId: string;
  initial: GroupOptionRow | null;
  onClose: () => void;
  onSaved: (saved: GroupOptionRow) => void;
}) {
  const [form, setForm] = useState<FormState>(initial ? rowToForm(initial) : BLANK);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dealer-assignment state — only used for Suggested products
  const [dealers, setDealers] = useState<DealerBasic[]>([]);
  const [assignAll, setAssignAll] = useState(true);
  const [selectedDealers, setSelectedDealers] = useState<Set<string>>(new Set());
  const [dealerEditable, setDealerEditable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/groups/${groupId}/dealers`)
      .then(r => r.json())
      .then((j: { data?: DealerBasic[] }) => { if (!cancelled) setDealers(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [groupId]);

  // Load existing assignments when editing
  useEffect(() => {
    if (!initial?.id || initial.required !== false) return;
    let cancelled = false;
    fetch(`/api/groups/${groupId}/option-assignments`)
      .then(r => r.json())
      .then((j: { data?: { option_id: string; dealer_id: string }[] }) => {
        if (cancelled) return;
        const mine = (j.data ?? []).filter(a => a.option_id === initial.id);
        if (mine.length > 0) {
          setAssignAll(false);
          setSelectedDealers(new Set(mine.map(a => a.dealer_id)));
        }
      })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [initial, groupId]);

  function f<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }
  function toggleAdType(t: "New" | "Used" | "CPO") {
    setForm(prev => {
      const set = new Set(prev.ad_types);
      if (set.has(t)) set.delete(t); else set.add(t);
      return { ...prev, ad_types: Array.from(set) };
    });
  }
  function toggleSelectedDealer(id: string) {
    setSelectedDealers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    setError(null);
    if (!form.option_name.trim()) { setError("Item name is required"); return; }
    setSaving(true);
    const body = {
      option_name: form.option_name.trim(),
      option_price: form.option_price.trim() || "NC",
      description: form.description,
      required: form.required,
      // Mirror old is_suggested semantics for backward-compat with the engine
      // until Stage 4 lands and everything reads the new required column.
      is_suggested: !form.required,
      applies_to: form.applies_to,
      ad_types: form.ad_types,
      models: form.models.trim(),
      models_not: form.models_not,
      trims: form.trims.trim(),
      trims_not: form.trims_not,
      makes: form.makes.trim(),
      makes_not: form.makes_not,
      separator_above: form.separator_above,
      separator_below: form.separator_below,
      spaces: form.spaces,
    };
    const url = initial
      ? `/api/group-options/${groupId}/${initial.id}`
      : `/api/group-options/${groupId}`;
    const method = initial ? "PATCH" : "POST";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({})) as { error?: string };
      setError(j.error ?? `Save failed (${res.status})`);
      setSaving(false);
      return;
    }
    const { data: saved } = await res.json() as { data: GroupOptionRow };

    // Apply dealer assignments only for Suggested products (engine still
    // requires is_suggested=true on the API for assignments).
    if (!form.required && !assignAll && selectedDealers.size > 0) {
      await fetch(`/api/groups/${groupId}/option-assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          option_id: saved.id,
          dealer_ids: Array.from(selectedDealers),
          dealer_editable: dealerEditable,
        }),
      });
    }

    setSaving(false);
    onSaved(saved);
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20, overflowY: "auto" }}
    >
      <div className="card" style={{ width: 640, maxWidth: "100%", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div className="px-5 py-4" style={{ borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 className="font-semibold text-base" style={{ color: "var(--text-primary)" }}>
            {initial ? "Edit Corporate Product" : "Add Corporate Product"}
          </h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, color: "var(--text-muted)", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>

        <div className="px-5 py-4" style={{ overflowY: "auto", maxHeight: "70vh" }}>
          {error && <div style={{ marginBottom: 12, padding: "8px 12px", background: "#ffebee", color: "#c62828", borderRadius: 4, fontSize: 12 }}>{error}</div>}

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Item Name *</label>
            <input value={form.option_name} onChange={e => f("option_name", e.target.value)} style={inp} placeholder="e.g. Lifetime Powertrain Warranty" />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Price</label>
            <input value={form.option_price} onChange={e => f("option_price", e.target.value)} style={inp} placeholder="e.g. 799 or NC or FR" />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Description</label>
            <RichTextEditor
              value={form.description}
              onChange={(html) => f("description", html)}
              placeholder="Optional description shown under the product name"
              minHeight={80}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Product Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              <TypePill active={form.required} color="#2e7d32" bg="#e8f5e9" border="#4caf50" label="Required" onClick={() => f("required", true)} />
              <TypePill active={!form.required} color="#e65100" bg="#fff3e0" border="#ffa500" label="Suggested" onClick={() => f("required", false)} />
            </div>
            <p style={{ fontSize: 11, color: "#78828c", marginTop: 6, marginBottom: 0 }}>
              {form.required
                ? "Required — auto-prepended and locked on every assigned dealer's addendum."
                : "Suggested — offered to dealers; visibility controlled by dealer assignment below."}
            </p>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Applies To</label>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { v: "all" as const, label: "All Vehicles" },
                { v: "rules" as const, label: "Assign with Rules" },
                { v: "none" as const, label: "No Vehicles" },
              ].map(opt => {
                const on = form.applies_to === opt.v;
                return (
                  <button key={opt.v} type="button" onClick={() => f("applies_to", opt.v)}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 4, fontWeight: 600, fontSize: 12, cursor: "pointer",
                      border: `2px solid ${on ? "#1976d2" : "#e0e0e0"}`,
                      background: on ? "#e3f2fd" : "#fff",
                      color: on ? "#0d47a1" : "#55595c",
                    }}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={lbl}>Vehicle Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              {(["New", "Used", "CPO"] as const).map(t => {
                const on = form.ad_types.includes(t);
                return (
                  <button key={t} type="button" onClick={() => toggleAdType(t)}
                    style={{
                      flex: 1, padding: "8px 0", borderRadius: 4, fontWeight: 600, fontSize: 12, cursor: "pointer",
                      border: `2px solid ${on ? "#1976d2" : "#e0e0e0"}`,
                      background: on ? "#e3f2fd" : "#fff",
                      color: on ? "#0d47a1" : "#55595c",
                    }}>
                    {t}
                  </button>
                );
              })}
            </div>
          </div>

          {form.applies_to === "rules" && (
            <>
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Models</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={form.models} onChange={e => f("models", e.target.value)} style={inp} placeholder="Comma-separated, blank = all" />
                  <NotPill on={form.models_not} onClick={() => f("models_not", !form.models_not)} />
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Trims</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={form.trims} onChange={e => f("trims", e.target.value)} style={inp} placeholder="Comma-separated, blank = all" />
                  <NotPill on={form.trims_not} onClick={() => f("trims_not", !form.trims_not)} />
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={lbl}>Makes</label>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={form.makes} onChange={e => f("makes", e.target.value)} style={inp} placeholder="Comma-separated, blank = all" />
                  <NotPill on={form.makes_not} onClick={() => f("makes_not", !form.makes_not)} />
                </div>
              </div>
            </>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              <input type="checkbox" checked={form.separator_above} onChange={e => f("separator_above", e.target.checked)} />
              Separator above
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              <input type="checkbox" checked={form.separator_below} onChange={e => f("separator_below", e.target.checked)} />
              Separator below
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
              Spaces
              <input type="number" min={0} max={10} value={form.spaces}
                onChange={e => f("spaces", Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)))}
                style={{ ...inp, width: 60, height: 32, padding: "4px 8px" }} />
            </label>
          </div>

          {!form.required && (
            <div style={{ marginTop: 18, padding: 14, border: "1px solid #e0e0e0", borderRadius: 6, background: "#fafafa" }}>
              <label style={lbl}>Assign to Dealers</label>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <button type="button" onClick={() => setAssignAll(true)}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    border: `2px solid ${assignAll ? "#7b1fa2" : "#e0e0e0"}`,
                    background: assignAll ? "#f3e5f5" : "#fff",
                    color: assignAll ? "#4a148c" : "#55595c",
                  }}>
                  All Dealers in Group
                </button>
                <button type="button" onClick={() => setAssignAll(false)}
                  style={{
                    flex: 1, padding: "8px 0", borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: "pointer",
                    border: `2px solid ${!assignAll ? "#7b1fa2" : "#e0e0e0"}`,
                    background: !assignAll ? "#f3e5f5" : "#fff",
                    color: !assignAll ? "#4a148c" : "#55595c",
                  }}>
                  Select Dealers
                </button>
              </div>

              {!assignAll && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: "#78828c", fontWeight: 600 }}>{selectedDealers.size} selected</span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" style={{ background: "none", border: "none", color: "#1976d2", fontSize: 11, cursor: "pointer" }}
                        onClick={() => setSelectedDealers(new Set(dealers.map(d => d.id)))}>Select all</button>
                      <button type="button" style={{ background: "none", border: "none", color: "#78828c", fontSize: 11, cursor: "pointer" }}
                        onClick={() => setSelectedDealers(new Set())}>Clear</button>
                    </div>
                  </div>
                  <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff" }}>
                    {dealers.length === 0 ? (
                      <p style={{ padding: 12, fontSize: 12, color: "#78828c", textAlign: "center" }}>No dealers in this group.</p>
                    ) : dealers.map(d => (
                      <label key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid #f0f0f0" }}>
                        <input type="checkbox" checked={selectedDealers.has(d.id)} onChange={() => toggleSelectedDealer(d.id)} />
                        <span style={{ fontSize: 13, color: "#333" }}>{d.name}</span>
                      </label>
                    ))}
                  </div>

                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #e0e0e0" }}>
                    <p style={{ fontSize: 11, fontWeight: 600, color: "#78828c", marginBottom: 6 }}>DEALER ACCESS</p>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c", marginBottom: 4 }}>
                      <input type="radio" checked={!dealerEditable} onChange={() => setDealerEditable(false)} />
                      Locked — dealer cannot edit or remove
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#55595c" }}>
                      <input type="radio" checked={dealerEditable} onChange={() => setDealerEditable(true)} />
                      Editable — copied to dealer&apos;s library (they can modify)
                    </label>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3" style={{ borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}>
          {error && <span style={{ fontSize: 12, color: "#c62828", marginRight: "auto" }}>{error}</span>}
          <button type="button" onClick={onClose}
            style={{ height: 36, padding: "0 16px", border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff", color: "#333", cursor: "pointer", fontSize: 13 }}>
            Cancel
          </button>
          <button type="button" onClick={() => void save()} disabled={saving}
            style={{ height: 36, padding: "0 16px", border: "none", borderRadius: 6, background: "#1976d2", color: "#fff", cursor: saving ? "default" : "pointer", fontSize: 13, fontWeight: 600 }}>
            {saving ? "Saving…" : initial ? "Save Changes" : "Add Product"}
          </button>
        </div>
      </div>
    </div>
  );
}

function NotPill({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      style={{
        height: 36, padding: "0 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
        border: `1px solid ${on ? "#c62828" : "#e0e0e0"}`,
        background: on ? "#ffebee" : "#fff",
        color: on ? "#c62828" : "#78828c", whiteSpace: "nowrap",
      }}>
      {on ? "NOT IN" : "IN"}
    </button>
  );
}
