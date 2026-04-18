"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import type { DecodeResult } from "@/lib/vin-decoder";

// ── Types ─────────────────────────────────────────────────────────────────────

type Props = {
  dealerId: string;
  onSaved?: () => void;
  initialTab?: Tab;
  label?: string;
};

type Tab = "vin" | "import";
type ImportMode = "update" | "replace";

const CONDITION_OPTIONS = ["New", "Used", "Certified"] as const;

const DA_IMPORT_FIELDS = [
  "Stock Number",
  "VIN",
  "Year",
  "Make",
  "Model",
  "Trim",
  "Body Style",
  "Color",
  "Mileage",
  "MSRP",
  "Condition",
] as const;

type DAField = (typeof DA_IMPORT_FIELDS)[number];

const REQUIRED_IMPORT_FIELDS: readonly DAField[] = [
  "Stock Number", "VIN", "Year", "Make", "Model", "MSRP",
];

const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  height: 36,
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "0 10px",
  fontSize: 13,
  background: "#fff",
  color: "var(--text-primary)",
  boxSizing: "border-box",
};

const LABEL_STYLE: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 4,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCondition(raw: string): string {
  const v = (raw ?? "").trim().toUpperCase();
  if (["N", "NEW"].includes(v)) return "New";
  if (["U", "USED"].includes(v)) return "Used";
  if (["C", "CPO", "CERTIFIED", "CERT"].includes(v)) return "Certified";
  return raw.trim() || "New";
}

// ── Field helpers ─────────────────────────────────────────────────────────────

type FormState = {
  stock_number: string;
  vin: string;
  year: string;
  make: string;
  model: string;
  trim: string;
  body_style: string;
  exterior_color: string;
  interior_color: string;
  engine: string;
  transmission: string;
  drivetrain: string;
  mileage: string;
  msrp: string;
  condition: string;
};

const EMPTY_FORM: FormState = {
  stock_number: "", vin: "", year: "", make: "", model: "", trim: "",
  body_style: "", exterior_color: "", interior_color: "", engine: "",
  transmission: "", drivetrain: "", mileage: "0", msrp: "", condition: "New",
};

// ── Main component ────────────────────────────────────────────────────────────

export default function AddVehicleModal({ dealerId, onSaved, initialTab = "vin", label }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>(initialTab);

  // VIN tab state
  const [vinInput, setVinInput] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [decodeResult, setDecodeResult] = useState<DecodeResult | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Import tab state
  const [importFile, setImportFile] = useState<File | null>(null);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileRows, setFileRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<DAField, string>>({} as Record<DAField, string>);
  const [importMode, setImportMode] = useState<ImportMode>("update");
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [importDone, setImportDone] = useState<{ imported: number; skipped: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  function close() {
    setOpen(false);
    setTab(initialTab);
    setVinInput("");
    setDecodeResult(null);
    setDecodeError(null);
    setForm(EMPTY_FORM);
    setSaveError(null);
    setImportFile(null);
    setFileHeaders([]);
    setFileRows([]);
    setMapping({} as Record<DAField, string>);
    setImportMode("update");
    setImportProgress(null);
    setImportDone(null);
    setImportError(null);
  }

  // ── VIN Decoder ─────────────────────────────────────────────────────────────

  async function handleDecode() {
    const vin = vinInput.trim().toUpperCase();
    if (vin.length !== 17) {
      setDecodeError("VIN must be exactly 17 characters");
      return;
    }
    setDecoding(true);
    setDecodeError(null);
    setDecodeResult(null);

    const res = await fetch(`/api/vehicles/decode?vin=${encodeURIComponent(vin)}`);
    const json = await res.json() as DecodeResult & { error?: string };
    setDecoding(false);

    if (!res.ok) {
      setDecodeError(json.error ?? "Decode failed");
      return;
    }

    setDecodeResult(json);
    setForm((f) => ({
      ...f,
      vin,
      year: json.year ? String(json.year) : f.year,
      make: json.make ?? f.make,
      model: json.model ?? f.model,
      trim: json.trim ?? f.trim,
      body_style: json.body_style ?? f.body_style,
      engine: json.engine ?? f.engine,
      transmission: json.transmission ?? f.transmission,
      drivetrain: json.drivetrain ?? f.drivetrain,
    }));
  }

  async function handleSave(openAddendum: boolean) {
    if (!form.stock_number.trim()) {
      setSaveError("Stock Number is required");
      return;
    }
    setSaving(true);
    setSaveError(null);

    const res = await fetch("/api/dealer-vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        year: form.year ? parseInt(form.year, 10) : null,
        mileage: form.mileage ? parseInt(form.mileage, 10) : 0,
        msrp: form.msrp ? parseFloat(form.msrp) : null,
        decode_source: decodeResult?.source ?? "manual",
        decode_flagged: decodeResult?.decode_flagged ?? false,
      }),
    });
    const json = await res.json() as { id?: string; error?: string };
    setSaving(false);

    if (!res.ok) {
      setSaveError(json.error ?? "Save failed");
      return;
    }

    onSaved?.();
    if (openAddendum && json.id) {
      router.push(`/dealer-vehicles/${json.id}/addendum`);
    } else {
      close();
    }
  }

  // ── File Import ─────────────────────────────────────────────────────────────

  function parseFile(file: File) {
    setImportFile(file);
    setImportDone(null);
    setImportError(null);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
        if (!raw.length) {
          setImportError("No data rows found in file");
          return;
        }
        const headers = Object.keys(raw[0]);
        setFileHeaders(headers);
        setFileRows(raw);

        // Auto-map by header name similarity
        const autoMap: Partial<Record<DAField, string>> = {};
        for (const field of DA_IMPORT_FIELDS) {
          const fLower = field.toLowerCase();
          const match = headers.find((h) => h.toLowerCase().includes(fLower.split(" ")[0]));
          if (match) autoMap[field] = match;
        }
        setMapping(autoMap as Record<DAField, string>);
      } catch {
        setImportError("Could not parse file. Make sure it is a valid Excel or CSV file.");
      }
    };
    reader.readAsBinaryString(file);
  }

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  }, []);

  async function handleImport() {
    if (!fileRows.length) return;
    setImporting(true);
    setImportError(null);
    setImportProgress({ done: 0, total: fileRows.length });
    setImportDone(null);

    function get(row: Record<string, string>, field: DAField): string {
      const col = mapping[field];
      return col ? (row[col] ?? "").trim() : "";
    }

    // Map all rows to typed vehicle objects; skip rows with no stock number
    const mapped = fileRows
      .map((row) => {
        const stock = get(row, "Stock Number");
        if (!stock) return null;
        const msrpRaw = get(row, "MSRP").replace(/[$,]/g, "");
        const mileageRaw = get(row, "Mileage").replace(/,/g, "");
        return {
          stock_number: stock,
          vin: get(row, "VIN").toUpperCase() || undefined,
          year: get(row, "Year") ? parseInt(get(row, "Year"), 10) : undefined,
          make: get(row, "Make") || undefined,
          model: get(row, "Model") || undefined,
          trim: get(row, "Trim") || undefined,
          body_style: get(row, "Body Style") || undefined,
          exterior_color: get(row, "Color") || undefined,
          mileage: mileageRaw ? parseInt(mileageRaw, 10) : 0,
          msrp: msrpRaw ? parseFloat(msrpRaw) : undefined,
          condition: normalizeCondition(get(row, "Condition")),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const BATCH = 50;
    let totalImported = 0;
    let totalSkipped = fileRows.length - mapped.length; // rows with no stock number

    for (let i = 0; i < mapped.length; i += BATCH) {
      const batch = mapped.slice(i, i + BATCH);
      const isFirstBatch = i === 0;

      try {
        const res = await fetch("/api/dealer-vehicles/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: importMode,
            vehicles: batch,
            deleteFirst: importMode === "replace" && isFirstBatch,
          }),
        });

        const json = await res.json() as { imported?: number; skipped?: number; error?: string };

        if (!res.ok) {
          setImportError(json.error ?? "Import failed");
          setImporting(false);
          setImportProgress(null);
          return;
        }

        totalImported += json.imported ?? 0;
        totalSkipped += json.skipped ?? 0;
        setImportProgress({ done: Math.min(i + BATCH, mapped.length), total: mapped.length });
      } catch {
        setImportError("Network error during import");
        setImporting(false);
        setImportProgress(null);
        return;
      }
    }

    setImporting(false);
    setImportProgress(null);
    setImportDone({ imported: totalImported, skipped: totalSkipped, total: fileRows.length });
    onSaved?.();
  }

  if (!open) {
    return (
      <button
        onClick={() => { setTab(initialTab); setOpen(true); }}
        style={{
          height: 36, padding: "0 16px", background: "#1976d2", color: "#fff",
          border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {label ?? "+ Add Vehicles"}
      </button>
    );
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={close}
        style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000,
        }}
      />

      <div
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
          background: "#fff", borderRadius: 6, zIndex: 1001,
          width: "min(780px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px", borderBottom: "1px solid var(--border)",
            display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            Add Vehicles
          </h2>
          <button onClick={close} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "var(--text-muted)", lineHeight: 1 }}>×</button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          {(["vin", "import"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "10px 20px", border: "none", background: "none",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
                color: tab === t ? "#1976d2" : "var(--text-muted)",
                borderBottom: tab === t ? "2px solid #1976d2" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {t === "vin" ? "VIN Decoder" : "File Import"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {tab === "vin" ? (
            <VinTab
              vinInput={vinInput}
              setVinInput={setVinInput}
              decoding={decoding}
              decodeResult={decodeResult}
              decodeError={decodeError}
              onDecode={handleDecode}
              form={form}
              setForm={setForm}
              saving={saving}
              saveError={saveError}
              onSave={handleSave}
              onClose={close}
            />
          ) : (
            <ImportTab
              importFile={importFile}
              fileHeaders={fileHeaders}
              fileRows={fileRows}
              mapping={mapping}
              setMapping={setMapping}
              importMode={importMode}
              setImportMode={setImportMode}
              importing={importing}
              importProgress={importProgress}
              importDone={importDone}
              importError={importError}
              dropRef={dropRef}
              fileInputRef={fileInputRef}
              onFileDrop={handleFileDrop}
              onFileChange={(f) => parseFile(f)}
              onImport={handleImport}
              onClose={close}
            />
          )}
        </div>
      </div>
    </>
  );
}

// ── VIN Tab ───────────────────────────────────────────────────────────────────

function VinTab({
  vinInput, setVinInput, decoding, decodeResult, decodeError, onDecode,
  form, setForm, saving, saveError, onSave, onClose,
}: {
  vinInput: string; setVinInput: (v: string) => void;
  decoding: boolean; decodeResult: DecodeResult | null; decodeError: string | null;
  onDecode: () => void;
  form: FormState; setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean; saveError: string | null;
  onSave: (openAddendum: boolean) => void;
  onClose: () => void;
}) {
  const field = (k: keyof FormState) => (
    <input
      type="text"
      value={form[k]}
      onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
      style={INPUT_STYLE}
    />
  );

  return (
    <div>
      {/* VIN decode row */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          type="text"
          value={vinInput}
          onChange={(e) => setVinInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && onDecode()}
          maxLength={17}
          placeholder="Enter 17-character VIN"
          style={{ ...INPUT_STYLE, flex: 1, fontFamily: "monospace", fontSize: 14 }}
        />
        <button
          onClick={onDecode}
          disabled={decoding}
          style={{
            height: 36, padding: "0 16px", background: "#1976d2", color: "#fff",
            border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
            cursor: decoding ? "not-allowed" : "pointer", whiteSpace: "nowrap",
          }}
        >
          {decoding ? "Decoding..." : "Decode"}
        </button>
      </div>

      {decodeError && (
        <div style={{ padding: "8px 12px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 13, marginBottom: 12 }}>
          {decodeError}
        </div>
      )}

      {decodeResult?.decode_flagged && decodeResult.source !== "partial" && (
        <div style={{ padding: "8px 12px", background: "#fffde7", border: "1px solid #fff176", borderRadius: 4, color: "#f57f17", fontSize: 13, marginBottom: 12 }}>
          Decoded from <strong>{decodeResult.source}</strong> — please verify vehicle details before saving.
        </div>
      )}

      {decodeResult?.source === "partial" && (
        <div style={{ padding: "8px 12px", background: "#fff3e0", border: "1px solid #ffcc02", borderRadius: 4, color: "#e65100", fontSize: 13, marginBottom: 12 }}>
          VIN not found in database — please enter vehicle details manually.
        </div>
      )}

      {/* Form fields */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 16px" }}>
        <div style={{ gridColumn: "1 / -1" }}>
          <label style={LABEL_STYLE}>Stock Number *</label>
          <input
            type="text"
            value={form.stock_number}
            onChange={(e) => setForm((f) => ({ ...f, stock_number: e.target.value }))}
            style={INPUT_STYLE}
            placeholder="Required"
          />
        </div>

        <div>
          <label style={LABEL_STYLE}>VIN</label>
          <input
            type="text"
            value={form.vin}
            onChange={(e) => setForm((f) => ({ ...f, vin: e.target.value.toUpperCase() }))}
            style={{ ...INPUT_STYLE, fontFamily: "monospace" }}
            maxLength={17}
          />
        </div>

        <div>
          <label style={LABEL_STYLE}>Year</label>
          <input type="number" value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: e.target.value }))} style={INPUT_STYLE} min="1900" max="2099" />
        </div>

        <div>
          <label style={LABEL_STYLE}>Make</label>
          {field("make")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Model</label>
          {field("model")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Trim</label>
          {field("trim")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Body Style</label>
          {field("body_style")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Exterior Color</label>
          {field("exterior_color")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Interior Color</label>
          {field("interior_color")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Engine</label>
          {field("engine")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Transmission</label>
          {field("transmission")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Drivetrain</label>
          {field("drivetrain")}
        </div>

        <div>
          <label style={LABEL_STYLE}>Mileage</label>
          <input type="number" value={form.mileage} onChange={(e) => setForm((f) => ({ ...f, mileage: e.target.value }))} style={INPUT_STYLE} min="0" />
        </div>

        <div>
          <label style={LABEL_STYLE}>MSRP</label>
          <input type="number" value={form.msrp} onChange={(e) => setForm((f) => ({ ...f, msrp: e.target.value }))} style={INPUT_STYLE} min="0" step="100" />
        </div>

        <div>
          <label style={LABEL_STYLE}>Condition</label>
          <select
            value={form.condition}
            onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value }))}
            style={{ ...INPUT_STYLE }}
          >
            {CONDITION_OPTIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {saveError && (
        <div style={{ padding: "8px 12px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 13, marginTop: 12 }}>
          {saveError}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 20 }}>
        <button onClick={onClose} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
          Cancel
        </button>
        <button
          onClick={() => onSave(false)}
          disabled={saving}
          style={{ height: 36, padding: "0 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}
        >
          {saving ? "Saving..." : "Save Vehicle"}
        </button>
        <button
          onClick={() => onSave(true)}
          disabled={saving}
          style={{ height: 36, padding: "0 16px", background: "#4caf50", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}
        >
          Save & Open Addendum
        </button>
      </div>
    </div>
  );
}

// ── Import Tab ────────────────────────────────────────────────────────────────

function ImportTab({
  importFile, fileHeaders, fileRows, mapping, setMapping,
  importMode, setImportMode,
  importing, importProgress, importDone, importError,
  dropRef, fileInputRef, onFileDrop, onFileChange, onImport, onClose,
}: {
  importFile: File | null;
  fileHeaders: string[];
  fileRows: Record<string, string>[];
  mapping: Record<DAField, string>;
  setMapping: React.Dispatch<React.SetStateAction<Record<DAField, string>>>;
  importMode: ImportMode;
  setImportMode: (m: ImportMode) => void;
  importing: boolean;
  importProgress: { done: number; total: number } | null;
  importDone: { imported: number; skipped: number; total: number } | null;
  importError: string | null;
  dropRef: React.RefObject<HTMLDivElement>;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileDrop: (e: React.DragEvent) => void;
  onFileChange: (f: File) => void;
  onImport: () => void;
  onClose: () => void;
}) {
  const missingRequired = REQUIRED_IMPORT_FIELDS.filter((f) => !mapping[f]);
  const canImport = fileRows.length > 0 && missingRequired.length === 0 && !importing && !importDone;

  return (
    <div>
      {/* Drop zone */}
      {!importFile ? (
        <div
          ref={dropRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onFileDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: "2px dashed var(--border)", borderRadius: 6, padding: "40px 20px",
            textAlign: "center", cursor: "pointer", background: "#fafafa", marginBottom: 16,
          }}
        >
          <p style={{ color: "var(--text-muted)", fontSize: 14, margin: 0 }}>
            Drag &amp; drop a file here, or click to browse
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
            Accepted: .xlsx, .xls, .csv, .txt
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,.csv,.txt"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFileChange(f);
            }}
          />
        </div>
      ) : (
        <div style={{ padding: "8px 12px", background: "#e3f2fd", border: "1px solid #bbdefb", borderRadius: 4, fontSize: 13, color: "#1565c0", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{importFile.name} — {fileRows.length} row{fileRows.length !== 1 ? "s" : ""} detected</span>
          <button onClick={() => onFileChange(importFile)} style={{ background: "none", border: "none", color: "#1565c0", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>Re-parse</button>
        </div>
      )}

      {/* Import mode selector */}
      {fileHeaders.length > 0 && !importDone && (
        <div style={{ marginBottom: 16, padding: "12px 14px", background: "#f5f6f7", border: "1px solid var(--border)", borderRadius: 4 }}>
          <p style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Import Mode
          </p>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10, cursor: "pointer" }}>
            <input
              type="radio"
              name="importMode"
              value="update"
              checked={importMode === "update"}
              onChange={() => setImportMode("update")}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Update existing inventory</span>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
                Matches on stock number. Updates existing vehicles and adds new ones. Print history unchanged.
              </p>
            </div>
          </label>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input
              type="radio"
              name="importMode"
              value="replace"
              checked={importMode === "replace"}
              onChange={() => setImportMode("replace")}
              style={{ marginTop: 3, flexShrink: 0 }}
            />
            <div>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Replace all inventory</span>
              <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0" }}>
                Deletes all current vehicles and replaces with this file.
              </p>
            </div>
          </label>
          {importMode === "replace" && (
            <div style={{ marginTop: 10, padding: "8px 10px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, fontSize: 12, color: "#c62828" }}>
              ⚠ This will delete all current vehicles and replace with the imported file. Print history is preserved.
            </div>
          )}
        </div>
      )}

      {/* Column mapper */}
      {fileHeaders.length > 0 && !importDone && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Map columns from your file:
          </p>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
            Fields marked <span style={{ color: "var(--error)" }}>*</span> are required.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px" }}>
            {DA_IMPORT_FIELDS.map((field) => {
              const required = REQUIRED_IMPORT_FIELDS.includes(field);
              return (
                <div key={field}>
                  <label style={LABEL_STYLE}>
                    {field}
                    {required && <span style={{ color: "var(--error)", marginLeft: 2 }}>*</span>}
                  </label>
                  <select
                    value={mapping[field] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                    style={{
                      ...INPUT_STYLE,
                      borderColor: required && !mapping[field] ? "#ff5252" : undefined,
                    }}
                  >
                    <option value="">— skip —</option>
                    {fileHeaders.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Required fields warning */}
      {missingRequired.length > 0 && fileHeaders.length > 0 && !importDone && (
        <div style={{ padding: "8px 12px", background: "#fff3e0", border: "1px solid #ffcc02", borderRadius: 4, fontSize: 13, color: "#e65100", marginBottom: 12 }}>
          Please map all required fields before importing: <strong>{missingRequired.join(", ")}</strong>
        </div>
      )}

      {importError && (
        <div style={{ padding: "8px 12px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 13, marginBottom: 12 }}>
          {importError}
        </div>
      )}

      {/* Progress display */}
      {importing && importProgress && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: "#1565c0", fontWeight: 500 }}>
              Importing... {importProgress.done} / {importProgress.total} vehicles
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {importProgress.total > 0 ? Math.round(importProgress.done / importProgress.total * 100) : 0}%
            </span>
          </div>
          <div style={{ height: 6, background: "#e3f2fd", borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", background: "#1976d2", borderRadius: 3,
              width: `${importProgress.total > 0 ? Math.round(importProgress.done / importProgress.total * 100) : 0}%`,
              transition: "width 200ms ease",
            }} />
          </div>
        </div>
      )}

      {/* Completion message */}
      {importDone && (
        <div style={{ padding: "12px 16px", background: "#e8f5e9", border: "1px solid #c8e6c9", borderRadius: 4, fontSize: 14, color: "#2e7d32", marginBottom: 16 }}>
          ✓ Import complete — <strong>{importDone.imported}</strong> imported
          {importDone.skipped > 0 && <>, <strong>{importDone.skipped}</strong> skipped (duplicate stock numbers)</>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 8 }}>
        <button onClick={onClose} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
          {importDone ? "Done" : "Cancel"}
        </button>
        {!importDone && !importing && fileRows.length > 0 && (
          <button
            onClick={onImport}
            disabled={!canImport}
            title={missingRequired.length > 0 ? "Please map all required fields before importing" : undefined}
            style={{
              height: 36, padding: "0 16px",
              background: canImport ? "#1976d2" : "#bdbdbd",
              color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600,
              cursor: canImport ? "pointer" : "not-allowed",
            }}
          >
            Import {fileRows.length} Vehicles
          </button>
        )}
      </div>
    </div>
  );
}
