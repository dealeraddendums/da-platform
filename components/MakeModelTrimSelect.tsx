"use client";

import { useEffect, useState } from "react";

type Make = { id: number; name: string };
type Model = { id: number; name: string; make_id: number };
type Trim = { id: number; name: string; model_id: number };

const ENTER = "__ENTER__";

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
 * Three NHTSA dropdowns (Make → Model → Trim) with an "Enter X" free-text
 * fallback for values that don't exist in NHTSA. Existing CSV-style saved
 * values fall through to free-text mode preserving the original string —
 * never destructive on load.
 *
 * Per-row right slots let the parent render IN/NOT toggles in the label row
 * without leaking the toggle state into this component.
 */
export default function MakeModelTrimSelect({
  make, model, trim,
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
  const [makes, setMakes] = useState<Make[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [trims, setTrims] = useState<Trim[]>([]);
  const [makeId, setMakeId] = useState<number | null>(null);
  const [modelId, setModelId] = useState<number | null>(null);
  // Sticky "user picked Enter X" flags. Without these, selecting "Enter Make"
  // would clear the value, leave makeMode === "empty", and the UI would stay
  // as a dropdown instead of switching to a text input.
  const [makeFree, setMakeFree] = useState(false);
  const [modelFree, setModelFree] = useState(false);
  const [trimFree, setTrimFree] = useState(false);

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

  useEffect(() => {
    if (models.length === 0) { setModelId(null); return; }
    const matched = models.find(m => m.name.toLowerCase() === model.trim().toLowerCase());
    setModelId(matched ? matched.id : null);
  }, [models, model]);

  useEffect(() => {
    if (modelId == null) { setTrims([]); return; }
    let cancelled = false;
    fetch(`/api/vehicles/trims?model_id=${modelId}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then((j: { data?: Trim[] }) => { if (!cancelled) setTrims(j.data ?? []); })
      .catch(() => null);
    return () => { cancelled = true; };
  }, [modelId]);

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
  function selectModel(rawValue: string) {
    if (rawValue === ENTER) {
      setModelFree(true);
      setTrimFree(false);
      onChange({ make, model: "", trim: "" });
      setModelId(null);
      return;
    }
    setModelFree(false);
    const id = rawValue ? parseInt(rawValue, 10) : NaN;
    const m = models.find(x => x.id === id);
    setModelId(m?.id ?? null);
    onChange({ make, model: m?.name ?? "", trim: "" });
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
  //      (legacy CSV-style strings like "Camry, Corolla").
  //   3. NHTSA returned an empty list for this tier (no models for the make,
  //      or no trims for the model) — fall to free-text so user has a way in.
  const makeMode: "select" | "free" | "empty" =
    makeFree ? "free"
    : !make ? "empty"
    : (makeId != null ? "select" : "free");
  const modelMode: "select" | "free" | "empty" =
    modelFree ? "free"
    : !model ? (makeMode === "empty" ? "empty" : (models.length === 0 && makeMode === "select" ? "free" : "empty"))
    : (modelId != null ? "select" : "free");
  const trimMode: "select" | "free" | "empty" =
    trimFree ? "free"
    : !trim ? (modelMode === "empty" ? "empty" : (trims.length === 0 && modelMode === "select" ? "free" : "empty"))
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
            placeholder="Enter model"
            disabled={!make}
            onChange={(v) => onChange({ make, model: v, trim: "" })}
            onRevert={() => {
              setModelFree(false);
              setTrimFree(false);
              onChange({ make, model: "", trim: "" });
              setModelId(null);
            }}
          />
        ) : (
          <select
            value={modelId != null ? String(modelId) : ""}
            onChange={(e) => selectModel(e.target.value)}
            disabled={!make || makeMode === "empty"}
            style={{ ...inp, opacity: makeMode === "empty" ? 0.5 : 1 }}
          >
            <option value="">All models</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            <option value={ENTER}>— Enter Model —</option>
          </select>
        )}
      </Row>

      <Row label="Trim" right={trimRight}>
        {trimMode === "free" ? (
          <FreeTextRevert
            value={trim}
            placeholder="Enter trim"
            disabled={!model}
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
            disabled={!model || modelMode === "empty"}
            style={{ ...inp, opacity: modelMode === "empty" ? 0.5 : 1 }}
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
