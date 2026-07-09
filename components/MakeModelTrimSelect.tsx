"use client";

import { useEffect, useRef, useState } from "react";

type Make = { id: number; name: string };
type Model = { id: number; name: string; make_id: number };
type Trim = { id: number; name: string; model_id: number };

const ENTER = "__ENTER__";

// Legacy rule rows use sentinel strings for "no restriction" ("ALL" on makes,
// "NONE"/"-NONE-" elsewhere). The options engine treats them as match-all, so
// render them as the empty "All X" dropdown state instead of falling into
// free-text mode with a literal "ALL" in the input.
function cleanSentinel(v: string): string {
  return /^(all|none|-none-)$/i.test(v.trim()) ? "" : v;
}

function splitCsv(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const inp: React.CSSProperties = {
  width: "100%", padding: "8px 10px", height: 36,
  border: "1px solid #e0e0e0", borderRadius: 6, background: "#fff",
  fontSize: 13, color: "#333",
};

const subLabel: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  fontSize: 10, fontWeight: 600, textTransform: "uppercase",
  letterSpacing: "0.05em", color: "#78828c", marginBottom: 4,
};

/**
 * NHTSA dropdowns (Make → Model → Trim) with an "Enter X" free-text fallback
 * for values that don't exist in NHTSA. MODEL is a multi-select (checkbox
 * dropdown) stored as a comma-separated string — the options engine's
 * listMatchesWithNot already splits on commas. Existing CSV-style saved values
 * whose tokens all match the catalog render as checked items; anything
 * unmatched falls through to free-text mode preserving the original string —
 * never destructive on load.
 *
 * Per-row right slots let the parent render IN/NOT toggles in the label row
 * without leaking the toggle state into this component.
 */
export default function MakeModelTrimSelect({
  make: makeProp, model: modelProp, trim: trimProp,
  onChange,
  makeRight, modelRight, trimRight,
}: {
  make: string;
  model: string;
  trim: string;
  onChange: (next: { make: string; model: string; trim: string }) => void;
  makeRight?: React.ReactNode;
  modelRight?: React.ReactNode;
  trimRight?: React.ReactNode;
}) {
  const make = cleanSentinel(makeProp);
  const model = cleanSentinel(modelProp);
  const trim = cleanSentinel(trimProp);

  const [makes, setMakes] = useState<Make[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [trims, setTrims] = useState<Trim[]>([]);
  const [makeId, setMakeId] = useState<number | null>(null);
  // Sticky "user picked Enter X" flags. Without these, selecting "Enter Make"
  // would clear the value, leave makeMode === "empty", and the UI would stay
  // as a dropdown instead of switching to a text input.
  const [makeFree, setMakeFree] = useState(false);
  const [modelFree, setModelFree] = useState(false);
  const [trimFree, setTrimFree] = useState(false);

  const modelTokens = splitCsv(model);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vehicles/makes")
      .then(r => r.ok ? r.json() : { data: [] })
      .then((j: { data?: Make[] }) => { if (!cancelled) setMakes(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (makes.length === 0) return;
    const matched = makes.find(m => m.name.toLowerCase() === make.trim().toLowerCase());
    setMakeId(matched ? matched.id : null);
  }, [makes, make]);

  useEffect(() => {
    if (makeId == null) { setModels([]); return; }
    let cancelled = false;
    fetch(`/api/vehicles/models?make_id=${makeId}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then((j: { data?: Model[] }) => { if (!cancelled) setModels(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [makeId]);

  // Model tokens matched against the catalog. Trims are only resolvable for a
  // SINGLE selected model (NHTSA trims hang off one model id).
  const matchedModels = modelTokens.map(
    t => models.find(m => m.name.toLowerCase() === t.toLowerCase()) ?? null,
  );
  const allModelsMatched = modelTokens.length > 0 && models.length > 0 && matchedModels.every(Boolean);
  const singleModelId = modelTokens.length === 1 && matchedModels[0] ? matchedModels[0].id : null;

  useEffect(() => {
    if (singleModelId == null) { setTrims([]); return; }
    let cancelled = false;
    fetch(`/api/vehicles/trims?model_id=${singleModelId}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then((j: { data?: Trim[] }) => { if (!cancelled) setTrims(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [singleModelId]);

  function selectMake(rawValue: string) {
    if (rawValue === ENTER) {
      setMakeFree(true);
      setModelFree(false);
      setTrimFree(false);
      onChange({ make: "", model: "", trim: "" });
      setMakeId(null);
      return;
    }
    setMakeFree(false);
    const id = rawValue ? parseInt(rawValue, 10) : NaN;
    const m = makes.find(x => x.id === id);
    setMakeId(m?.id ?? null);
    onChange({ make: m?.name ?? "", model: "", trim: "" });
  }
  function toggleModel(name: string) {
    const next = modelTokens.some(t => t.toLowerCase() === name.toLowerCase())
      ? modelTokens.filter(t => t.toLowerCase() !== name.toLowerCase())
      : [...modelTokens, name];
    // Trim only survives a single-model selection; clear it on any change.
    onChange({ make, model: next.join(","), trim: "" });
  }
  function clearModels() {
    setModelFree(false);
    onChange({ make, model: "", trim: "" });
  }
  function enterModelFree() {
    setModelFree(true);
    setTrimFree(false);
    onChange({ make, model: "", trim: "" });
  }
  function selectTrim(rawValue: string) {
    if (rawValue === ENTER) {
      setTrimFree(true);
      onChange({ make, model, trim: "" });
      return;
    }
    setTrimFree(false);
    const id = rawValue ? parseInt(rawValue, 10) : NaN;
    const t = trims.find(x => x.id === id);
    onChange({ make, model, trim: t?.name ?? "" });
  }

  // Three sources for "free-text mode":
  //   1. User explicitly picked "— Enter X —" from the dropdown (the *Free flag).
  //   2. Saved value doesn't match anything in the loaded NHTSA catalog
  //      (legacy CSV-style strings with tokens outside the catalog).
  //   3. NHTSA returned an empty list for this tier (no models for the make,
  //      or no trims for the model) — fall to free-text so user has a way in.
  const makeMode: "select" | "free" | "empty" =
    makeFree ? "free"
    : !make ? "empty"
    : (makeId != null ? "select" : "free");
  const modelMode: "select" | "free" | "empty" =
    modelFree ? "free"
    : modelTokens.length === 0 ? (makeMode === "empty" ? "empty" : (models.length === 0 && makeMode === "select" ? "free" : "empty"))
    : (allModelsMatched ? "select" : "free");
  const trimMode: "select" | "free" | "empty" =
    trimFree ? "free"
    : !trim ? (modelMode === "empty" ? "empty" : (singleModelId != null && trims.length === 0 && modelMode === "select" ? "free" : "empty"))
    : (trims.find(t => t.name.toLowerCase() === trim.trim().toLowerCase()) ? "select" : "free");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Row label="Make" right={makeRight}>
        {makeMode === "free" ? (
          <FreeTextRevert
            value={make}
            placeholder="Enter make"
            onChange={(v) => onChange({ make: v, model: "", trim: "" })}
            onRevert={() => {
              setMakeFree(false);
              setModelFree(false);
              setTrimFree(false);
              onChange({ make: "", model: "", trim: "" });
              setMakeId(null);
            }}
          />
        ) : (
          <select
            value={makeId != null ? String(makeId) : ""}
            onChange={(e) => selectMake(e.target.value)}
            style={inp}
          >
            <option value="">All makes</option>
            {makes.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            <option value={ENTER}>— Enter Make —</option>
          </select>
        )}
      </Row>

      <Row label="Model" right={modelRight}>
        {modelMode === "free" ? (
          <FreeTextRevert
            value={model}
            placeholder="Enter model (comma-separate for several)"
            disabled={!make}
            onChange={(v) => onChange({ make, model: v, trim: "" })}
            onRevert={() => {
              setModelFree(false);
              setTrimFree(false);
              onChange({ make, model: "", trim: "" });
            }}
          />
        ) : (
          <MultiCheckDropdown
            disabled={!make || makeMode === "empty"}
            allLabel="All models"
            options={models.map(m => m.name)}
            selected={modelTokens}
            onToggle={toggleModel}
            onClear={clearModels}
            onEnterFree={enterModelFree}
            enterLabel="— Enter Model —"
          />
        )}
      </Row>

      <Row label="Trim" right={trimRight}>
        {trimMode === "free" ? (
          <FreeTextRevert
            value={trim}
            placeholder="Enter trim"
            disabled={modelTokens.length === 0}
            onChange={(v) => onChange({ make, model, trim: v })}
            onRevert={() => {
              setTrimFree(false);
              onChange({ make, model, trim: "" });
            }}
          />
        ) : (
          <select
            value={trim ? (trims.find(t => t.name.toLowerCase() === trim.trim().toLowerCase())?.id ?? "") : ""}
            onChange={(e) => selectTrim(e.target.value)}
            disabled={singleModelId == null || modelMode === "empty"}
            title={modelTokens.length > 1 ? "Trim rules apply to a single model — select exactly one model to pick trims" : undefined}
            style={{ ...inp, opacity: singleModelId == null ? 0.5 : 1 }}
          >
            <option value="">All trims</option>
            {trims.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            <option value={ENTER}>— Enter Trim —</option>
          </select>
        )}
      </Row>
    </div>
  );
}

function Row({ label, right, children }: { label: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <label style={subLabel}>
        <span>{label}</span>
        {right}
      </label>
      {children}
    </div>
  );
}

/**
 * Closed state looks like a <select>; open state is a checkbox list. Selection
 * summary reads "All models" (none), the names joined by ", " (few), or
 * "N models" (many).
 */
function MultiCheckDropdown({
  disabled, allLabel, options, selected, onToggle, onClear, onEnterFree, enterLabel,
}: {
  disabled?: boolean;
  allLabel: string;
  options: string[];
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
  onEnterFree: () => void;
  enterLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selectedSet = new Set(selected.map(s => s.toLowerCase()));
  const summary =
    selected.length === 0 ? allLabel
    : selected.length <= 3 ? selected.join(", ")
    : `${selected.length} models`;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        style={{
          ...inp, textAlign: "left", cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.5 : 1, display: "flex", alignItems: "center",
          justifyContent: "space-between", gap: 8,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected.length === 0 ? "#333" : "#1a1a2e" }}>
          {summary}
        </span>
        <span style={{ color: "#78828c", fontSize: 10 }}>▾</span>
      </button>
      {open && !disabled && (
        <div style={{
          position: "absolute", top: 38, left: 0, right: 0, zIndex: 30,
          background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6,
          boxShadow: "0 4px 12px rgba(0,0,0,0.08)", maxHeight: 240, overflowY: "auto",
        }}>
          <div
            onClick={() => { onClear(); setOpen(false); }}
            style={{ padding: "8px 10px", fontSize: 13, cursor: "pointer", color: selected.length === 0 ? "#1976d2" : "#333", fontWeight: selected.length === 0 ? 600 : 400, borderBottom: "1px solid #f0f0f0" }}
          >
            {allLabel}
          </div>
          {options.map(name => (
            <label key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedSet.has(name.toLowerCase())}
                onChange={() => onToggle(name)}
                style={{ accentColor: "#1976d2" }}
              />
              {name}
            </label>
          ))}
          <div
            onClick={() => { onEnterFree(); setOpen(false); }}
            style={{ padding: "8px 10px", fontSize: 13, cursor: "pointer", color: "#78828c", borderTop: "1px solid #f0f0f0" }}
          >
            {enterLabel}
          </div>
        </div>
      )}
    </div>
  );
}

function FreeTextRevert({
  value, placeholder, disabled, onChange, onRevert,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onRevert: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      <input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inp, flex: 1, opacity: disabled ? 0.5 : 1 }}
      />
      <button
        type="button"
        onClick={onRevert}
        title="Pick from list"
        style={{
          height: 36, padding: "0 8px", border: "1px solid #e0e0e0", borderRadius: 6,
          background: "#fafafa", color: "#78828c", cursor: "pointer", fontSize: 11,
          whiteSpace: "nowrap",
        }}
      >
        ↺
      </button>
    </div>
  );
}
