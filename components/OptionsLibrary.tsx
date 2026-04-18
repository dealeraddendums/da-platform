"use client";

import { useState, useEffect, useCallback } from "react";
import { formatOptionPrice } from "@/lib/option-price";
import type { AddendumLibraryRow } from "@/lib/db";

// ── Types ──────────────────────────────────────────────────────────────────────

type FormData = {
  option_name: string;
  item_price: string;
  description: string;
  ad_type: "New" | "Used" | "Both";
  models: string;
  models_not: boolean;
  trims: string;
  trims_not: boolean;
  makes: string;
  makes_not: boolean;
  body_styles: string;
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
};

const BLANK: FormData = {
  option_name: "", item_price: "", description: "", ad_type: "Both",
  models: "", models_not: false, trims: "", trims_not: false,
  makes: "", makes_not: false, body_styles: "",
  year_condition: 0, year_value: "",
  miles_condition: 0, miles_value: "",
  msrp_condition: 0, msrp1: "", msrp2: "",
  show_models_only: false, separator_above: false, separator_below: false, spaces: 2,
};

function rowToForm(r: AddendumLibraryRow): FormData {
  return {
    option_name: r.option_name, item_price: r.item_price, description: r.description,
    ad_type: (r.ad_type as FormData["ad_type"]) || "Both",
    models: r.models, models_not: r.models_not,
    trims: r.trims, trims_not: r.trims_not,
    makes: r.makes, makes_not: r.makes_not,
    body_styles: r.body_styles,
    year_condition: r.year_condition, year_value: r.year_value != null ? String(r.year_value) : "",
    miles_condition: r.miles_condition, miles_value: r.miles_value != null ? String(r.miles_value) : "",
    msrp_condition: r.msrp_condition,
    msrp1: r.msrp1 != null ? String(r.msrp1) : "",
    msrp2: r.msrp2 != null ? String(r.msrp2) : "",
    show_models_only: r.show_models_only, separator_above: r.separator_above,
    separator_below: r.separator_below, spaces: r.spaces,
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
const btnDanger: React.CSSProperties = {
  padding: "5px 10px", background: "#ff5252", color: "#fff", border: "none",
  borderRadius: 4, cursor: "pointer", fontSize: 12, fontWeight: 600,
};
const btnGhost: React.CSSProperties = {
  padding: "7px 14px", background: "#fff", color: "#55595c",
  border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13,
};

// ── TagInput ───────────────────────────────────────────────────────────────────

function TagInput({ value, onChange, placeholder = "Type and press Enter…" }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  const [input, setInput] = useState("");
  const tags = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];

  function add() {
    const trimmed = input.trim();
    if (!trimmed) return;
    const next = [...tags.filter(t => t !== trimmed), trimmed].join(",");
    onChange(next);
    setInput("");
  }

  function remove(tag: string) {
    onChange(tags.filter(t => t !== tag).join(","));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
          style={{ ...inp, flex: 1 }}
        />
        <button type="button" onClick={add} style={{ ...btnGhost, padding: "7px 12px" }}>+</button>
      </div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {tags.map(t => (
            <span key={t} style={{ background: "#e3f2fd", color: "#1565c0", fontSize: 11, fontWeight: 600, padding: "3px 8px", borderRadius: 12, display: "flex", alignItems: "center", gap: 4 }}>
              {t}
              <button type="button" onClick={() => remove(t)} style={{ background: "none", border: "none", cursor: "pointer", color: "#1565c0", fontSize: 13, padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── InNotIn ────────────────────────────────────────────────────────────────────

function InNotIn({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: "flex", borderRadius: 4, overflow: "hidden", border: "1px solid #e0e0e0", width: "fit-content" }}>
      {[false, true].map(v => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700,
            background: value === v ? "#1976d2" : "#fff",
            color: value === v ? "#fff" : "#55595c",
          }}
        >
          {v ? "NOT IN" : "IN"}
        </button>
      ))}
    </div>
  );
}

// ── PriceHelp ──────────────────────────────────────────────────────────────────

const PRICE_CODES = [
  ["NP", "Do not display price"],
  ["FR", "Free"],
  ["INC", "Included"],
  ["NC", "No Charge"],
  ["%", "Percentage of MSRP (e.g. 5%)"],
  ["|", "Show price but exclude from subtotal/total"],
  ["^", "Include in subtotal but hide displayed price"],
  ["~", "Append extra text after price (e.g. 199~*)"],
];

function PriceHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }} onClick={onClose}>
      <div
        style={{ position: "absolute", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 16, width: 320, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 13, color: "#333", marginBottom: 10 }}>Price Modifier Codes</div>
        {PRICE_CODES.map(([code, desc]) => (
          <div key={code} style={{ display: "flex", gap: 10, marginBottom: 6, fontSize: 12 }}>
            <span style={{ background: "#f5f6f7", borderRadius: 3, padding: "2px 7px", fontFamily: "monospace", fontWeight: 700, color: "#1976d2", flexShrink: 0 }}>{code}</span>
            <span style={{ color: "#55595c" }}>{desc}</span>
          </div>
        ))}
        <button type="button" onClick={onClose} style={{ ...btnGhost, width: "100%", marginTop: 8 }}>Close</button>
      </div>
    </div>
  );
}

// ── ImagePickerModal ───────────────────────────────────────────────────────────

function ImagePickerModal({
  onInsert, onClose,
}: {
  onInsert: (url: string, target: "description" | "item_name") => void;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"library" | "upload">("library");
  const [images, setImages] = useState<Array<{ key: string; url: string }>>([]);
  const [loadingLib, setLoadingLib] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [insertTarget, setInsertTarget] = useState<"description" | "item_name">("description");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => { void loadLibrary(); }, []);

  async function loadLibrary() {
    setLoadingLib(true);
    try {
      const res = await fetch("/api/option-images");
      const json = await res.json() as { images?: Array<{ key: string; url: string }> };
      setImages(json.images ?? []);
    } catch { setImages([]); }
    finally { setLoadingLib(false); }
  }

  function handleFileSelect(file: File) {
    setUploadFile(file);
    setUploadError(null);
    const reader = new FileReader();
    reader.onload = e => setUploadPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function handleUpload() {
    if (!uploadFile) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      const res = await fetch("/api/option-images/upload", { method: "POST", body: fd });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok) { setUploadError(json.error ?? "Upload failed"); return; }
      if (json.url) {
        setSelectedUrl(json.url);
        setActiveTab("library");
        void loadLibrary();
        setUploadFile(null);
        setUploadPreview(null);
      }
    } finally { setUploading(false); }
  }

  const filtered = images.filter(img => !searchQ || img.key.toLowerCase().includes(searchQ.toLowerCase()));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100 }}>
      <div style={{ background: "#fff", borderRadius: 6, width: 640, maxWidth: "96vw", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #e0e0e0", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#333" }}>Product Image Library</div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: "#78828c" }}>×</button>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid #e0e0e0", flexShrink: 0 }}>
          {(["library", "upload"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              style={{ padding: "10px 20px", background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: activeTab === tab ? 600 : 400, color: activeTab === tab ? "#1976d2" : "#55595c", borderBottom: activeTab === tab ? "2px solid #1976d2" : "2px solid transparent", marginBottom: -1 }}>
              {tab === "library" ? "Library" : "Upload New"}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {activeTab === "library" ? (
            <div>
              <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                placeholder="Search images…" style={{ ...inp, marginBottom: 14 }} />
              {loadingLib ? (
                <div style={{ textAlign: "center", padding: 32, color: "#78828c" }}>Loading…</div>
              ) : filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: 32, color: "#78828c" }}>
                  {images.length === 0 ? "No images yet. Upload one to get started." : "No images match your search."}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {filtered.map(img => (
                    <div key={img.key} onClick={() => setSelectedUrl(img.url)}
                      style={{ border: `2px solid ${selectedUrl === img.url ? "#1976d2" : "#e0e0e0"}`, borderRadius: 4, padding: 4, cursor: "pointer", background: selectedUrl === img.url ? "#e3f2fd" : "#fafafa", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt={img.key} style={{ width: "100%", height: 80, objectFit: "contain" }} />
                      <div style={{ fontSize: 10, color: "#78828c", textAlign: "center", wordBreak: "break-all" }}>
                        {img.key.split("/").pop()?.replace(/^\d+-/, "") ?? img.key}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); const fl = e.dataTransfer.files[0]; if (fl) handleFileSelect(fl); }}
                onClick={() => (document.getElementById("img-upload-input") as HTMLInputElement | null)?.click()}
                style={{ border: `2px dashed ${dragOver ? "#1976d2" : "#e0e0e0"}`, borderRadius: 6, padding: 32, textAlign: "center", cursor: "pointer", background: dragOver ? "#e3f2fd" : "#fafafa" }}>
                {uploadPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={uploadPreview} alt="Preview" style={{ maxHeight: 160, maxWidth: "100%", objectFit: "contain" }} />
                ) : (
                  <>
                    <div style={{ fontSize: 32, color: "#e0e0e0", marginBottom: 8 }}>↑</div>
                    <div style={{ fontSize: 13, color: "#55595c", marginBottom: 4 }}>Drag & drop or click to select</div>
                    <div style={{ fontSize: 11, color: "#78828c" }}>PNG, JPG, GIF, WebP — max 5MB</div>
                  </>
                )}
              </div>
              <input id="img-upload-input" type="file" accept="image/*" style={{ display: "none" }}
                onChange={e => { const fl = e.target.files?.[0]; if (fl) handleFileSelect(fl); }} />
              {uploadFile && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#55595c" }}>
                  Selected: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)
                </div>
              )}
              {uploadError && (
                <div style={{ marginTop: 8, padding: "6px 10px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4, color: "#c62828", fontSize: 12 }}>
                  {uploadError}
                </div>
              )}
              {uploadFile && (
                <button onClick={() => void handleUpload()} disabled={uploading}
                  style={{ ...btnPrimary, marginTop: 12, width: "100%" }}>
                  {uploading ? "Uploading…" : "Upload Image"}
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 20px", borderTop: "1px solid #e0e0e0", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 16, fontSize: 12, alignItems: "center" }}>
            <span style={{ color: "#55595c", fontWeight: 600 }}>Insert into:</span>
            {([["description", "Description"], ["item_name", "Item Name"]] as const).map(([val, label]) => (
              <label key={val} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: "#333" }}>
                <input type="radio" name="imgInsertTarget" value={val} checked={insertTarget === val}
                  onChange={() => setInsertTarget(val)} />
                {label}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={btnGhost}>Cancel</button>
            <button onClick={() => { if (selectedUrl) onInsert(selectedUrl, insertTarget); }} disabled={!selectedUrl}
              style={{ ...btnPrimary, opacity: selectedUrl ? 1 : 0.5, cursor: selectedUrl ? "pointer" : "default" }}>
              Insert Image
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Option form ────────────────────────────────────────────────────────────────

function OptionForm({
  form, setForm, appliesTo, setAppliesTo, showPriceHelp, setShowPriceHelp,
}: {
  form: FormData;
  setForm: React.Dispatch<React.SetStateAction<FormData>>;
  appliesTo: "all" | "rules";
  setAppliesTo: (v: "all" | "rules") => void;
  showPriceHelp: boolean;
  setShowPriceHelp: (v: boolean) => void;
}) {
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);

  function f(field: keyof FormData, value: unknown) {
    setForm(prev => ({ ...prev, [field]: value }));
  }

  async function handleAiGenerate() {
    const name = form.option_name.trim();
    if (!name) { setAiError("Enter an item name first"); return; }
    setAiGenerating(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai-content/option-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemName: name, price: form.item_price }),
      });
      const json = await res.json() as { description?: string; error?: string };
      if (!res.ok) { setAiError(json.error ?? "Generation failed"); return; }
      f("description", json.description ?? "");
      setAiGenerated(true);
    } catch { setAiError("Network error"); }
    finally { setAiGenerating(false); }
  }

  const row = (label: string, children: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <label style={lbl}>{label}</label>
      {children}
    </div>
  );

  return (
    <div>
      {row("Item Name *", (
        <input value={form.option_name} onChange={e => f("option_name", e.target.value)} style={inp} placeholder="e.g. Ceramic Tint" />
      ))}

      {row("Price", (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={form.item_price} onChange={e => f("item_price", e.target.value)} style={{ ...inp, flex: 1 }} placeholder="e.g. 799 or NC or FR" />
          <button type="button" onClick={() => setShowPriceHelp(true)}
            style={{ width: 28, height: 28, borderRadius: "50%", background: "#e3f2fd", border: "none", cursor: "pointer", color: "#1976d2", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
            ?
          </button>
        </div>
      ))}

      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
          <label style={lbl}>Description</label>
          <button type="button" onClick={() => void handleAiGenerate()} disabled={aiGenerating}
            style={{ background: "none", border: "none", cursor: aiGenerating ? "default" : "pointer", color: "#1565c0", fontSize: 12, fontWeight: 700, padding: "2px 6px", display: "flex", alignItems: "center", gap: 3 }}>
            {aiGenerating ? "Generating…" : "✦ Generate"}
          </button>
        </div>
        <textarea
          value={form.description}
          onChange={e => { f("description", e.target.value); setAiGenerated(false); }}
          style={{ ...inp, height: 64, resize: "vertical", opacity: aiGenerating ? 0.5 : 1 }}
          placeholder={aiGenerating ? "Generating description…" : "Optional description shown under the option name"}
          disabled={aiGenerating}
        />
        {aiGenerated && !aiGenerating && (
          <p style={{ fontSize: 11, color: "#1565c0", marginTop: 4, marginBottom: 0 }}>✦ AI generated — edit as needed</p>
        )}
        {aiError && (
          <p style={{ fontSize: 11, color: "#c62828", marginTop: 4, marginBottom: 0 }}>{aiError}</p>
        )}
        <button type="button" onClick={() => setShowImagePicker(true)}
          style={{ marginTop: 6, padding: "4px 10px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 11, color: "#55595c", fontWeight: 600 }}>
          + Add Image
        </button>
      </div>

      {row("Type", (
        <div style={{ display: "flex", gap: 8 }}>
          {(["New", "Used", "Both"] as const).map(v => (
            <button type="button" key={v} onClick={() => f("ad_type", v)}
              style={{ flex: 1, padding: "6px 0", borderRadius: 4, border: `2px solid ${form.ad_type === v ? "#1976d2" : "#e0e0e0"}`, background: form.ad_type === v ? "#e3f2fd" : "#fff", color: form.ad_type === v ? "#1976d2" : "#55595c", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
              {v}
            </button>
          ))}
        </div>
      ))}

      {/* Applies To toggle */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Applies To</label>
        <div style={{ display: "flex", gap: 8 }}>
          {([["all", "All Vehicles"], ["rules", "Assign with Rules"]] as const).map(([v, label]) => (
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
      </div>

      {/* Rules section — only shown when "Assign with Rules" */}
      {appliesTo === "rules" && (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 6, padding: "14px 16px", marginBottom: 14, background: "#fafafa" }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ ...lbl, margin: 0 }}>Model</label>
              <InNotIn value={form.models_not} onChange={v => f("models_not", v)} />
            </div>
            <TagInput value={form.models} onChange={v => f("models", v)} placeholder="All models" />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ ...lbl, margin: 0 }}>Trim</label>
              <InNotIn value={form.trims_not} onChange={v => f("trims_not", v)} />
            </div>
            <TagInput value={form.trims} onChange={v => f("trims", v)} placeholder="All trims" />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ ...lbl, margin: 0 }}>Make</label>
              <InNotIn value={form.makes_not} onChange={v => f("makes_not", v)} />
            </div>
            <TagInput value={form.makes} onChange={v => f("makes", v)} placeholder="All makes" />
          </div>

          {row("Style", (
            <TagInput value={form.body_styles} onChange={v => f("body_styles", v)} placeholder="All styles" />
          ))}

          {row("Year", (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select value={form.year_condition} onChange={e => f("year_condition", parseInt(e.target.value))}
                style={{ ...inp, width: 130, flex: "none" }}>
                <option value={0}>All years</option>
                <option value={1}>Equal to</option>
                <option value={2}>Before</option>
                <option value={3}>After</option>
              </select>
              {form.year_condition !== 0 && (
                <input type="number" value={form.year_value} onChange={e => f("year_value", e.target.value)}
                  style={{ ...inp, width: 100, flex: "none" }} placeholder="e.g. 2020" min={1990} max={2030} />
              )}
            </div>
          ))}

          {row("Mileage", (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <select value={form.miles_condition} onChange={e => f("miles_condition", parseInt(e.target.value))}
                style={{ ...inp, width: 130, flex: "none" }}>
                <option value={0}>All mileage</option>
                <option value={1}>Under</option>
                <option value={2}>Over</option>
              </select>
              {form.miles_condition !== 0 && (
                <input type="number" value={form.miles_value} onChange={e => f("miles_value", e.target.value)}
                  style={{ ...inp, width: 120, flex: "none" }} placeholder="miles" min={0} />
              )}
            </div>
          ))}

          {row("MSRP", (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={form.msrp_condition} onChange={e => f("msrp_condition", parseInt(e.target.value))}
                style={{ ...inp, width: 130, flex: "none" }}>
                <option value={0}>All prices</option>
                <option value={1}>Under</option>
                <option value={2}>Over</option>
                <option value={3}>Between</option>
              </select>
              {form.msrp_condition !== 0 && (
                <input type="number" value={form.msrp1} onChange={e => f("msrp1", e.target.value)}
                  style={{ ...inp, width: 120, flex: "none" }} placeholder="$" min={0} />
              )}
              {form.msrp_condition === 3 && (
                <>
                  <span style={{ fontSize: 12, color: "#78828c" }}>and</span>
                  <input type="number" value={form.msrp2} onChange={e => f("msrp2", e.target.value)}
                    style={{ ...inp, width: 120, flex: "none" }} placeholder="$" min={0} />
                </>
              )}
            </div>
          ))}

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "#333" }}>
            <input type="checkbox" checked={form.show_models_only}
              onChange={e => f("show_models_only", e.target.checked)}
              style={{ width: 14, height: 14 }} />
            Show only for specified models
          </label>

          <p style={{ fontSize: 11, color: "#78828c", marginTop: 10, marginBottom: 0 }}>
            Leave any field empty to match all values for that field.
          </p>
        </div>
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

      {showImagePicker && (
        <ImagePickerModal
          onInsert={(url, target) => {
            const tag = `<img src="${url}" width="125" style="max-width:125px;" />`;
            if (target === "item_name") {
              f("option_name", form.option_name + tag);
            } else {
              f("description", form.description + tag);
            }
            setShowImagePicker(false);
          }}
          onClose={() => setShowImagePicker(false)}
        />
      )}
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
  const [appliesTo, setAppliesTo] = useState<"all" | "rules">("all");
  const [showPriceHelp, setShowPriceHelp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

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
    const hasRules = !!(item.models || item.trims || item.makes || item.body_styles || item.year_condition || item.miles_condition || item.msrp_condition);
    setAppliesTo(hasRules ? "rules" : "all");
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
      };
      const payload = appliesTo === "all"
        ? { ...base, models: "", models_not: false, trims: "", trims_not: false, makes: "", makes_not: false, body_styles: "", year_condition: 0, year_value: null, miles_condition: 0, miles_value: null, msrp_condition: 0, msrp1: null, msrp2: null, show_models_only: false }
        : base;
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

  function enterReorder() {
    setReorderItems([...items]);
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

  function adTypeBadge(t: string) {
    const styles: Record<string, React.CSSProperties> = {
      New:  { background: "#e8f5e9", color: "#2e7d32" },
      Used: { background: "#e3f2fd", color: "#1565c0" },
      Both: { background: "#f5f6f7", color: "#55595c" },
    };
    return (
      <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, ...(styles[t] ?? styles.Both) }}>{t}</span>
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
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#fff", margin: 0 }}>Addendum Options</h1>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", marginTop: 3 }}>
            {total > 0 ? `${total} option${total !== 1 ? "s" : ""}` : "Define options that auto-apply to vehicle addendums"}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!reorderMode ? (
            <>
              <button onClick={enterReorder} disabled={items.length < 2}
                style={{ ...btnGhost, background: "#fff", color: "#333" }}>
                ⇅ Re-order
              </button>
              <button onClick={openAdd}
                style={{ ...btnPrimary, background: "#4caf50", border: "none", display: "flex", alignItems: "center", gap: 5 }}>
                + Add Option
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
            <div style={{ fontSize: 14, color: "#78828c", marginBottom: 16 }}>No options yet. Add your first option to get started.</div>
            <button onClick={openAdd} style={{ ...btnPrimary, background: "#4caf50" }}>+ Add Option</button>
          </div>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f5f6f7", borderBottom: "1px solid #e0e0e0" }}>
                  {reorderMode && <th style={{ width: 40, padding: "10px 8px" }} />}
                  <th style={th}>Option Name</th>
                  <th style={th}>Description</th>
                  <th style={th}>New/Used</th>
                  <th style={th}>Model</th>
                  <th style={th}>Trim</th>
                  <th style={th}>Style</th>
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
                      <td style={td}>
                        <div style={{ fontWeight: 600, color: "#333", fontSize: 13 }}>{item.option_name}</div>
                      </td>
                      <td style={td}>
                        <span style={{ color: "#78828c", fontSize: 12 }}>
                          {item.description ? (item.description.length > 50 ? item.description.slice(0, 50) + "…" : item.description) : <span style={{ color: "#ccc" }}>—</span>}
                        </span>
                      </td>
                      <td style={td}>{adTypeBadge(item.ad_type)}</td>
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

            {/* Pagination */}
            {!reorderMode && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid #e0e0e0", background: "#fafafa" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: "#78828c" }}>Rows per page:</span>
                  <select value={perPage} onChange={e => { setPerPage(parseInt(e.target.value)); setPage(1); }}
                    style={{ padding: "4px 8px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 12, color: "#333" }}>
                    {[10, 25, 50].map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div style={{ fontSize: 12, color: "#78828c" }}>
                  {total > 0 ? `${(page - 1) * perPage + 1}–${Math.min(page * perPage, total)} of ${total}` : "0 results"}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}
                    style={{ padding: "5px 12px", border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", cursor: page <= 1 ? "default" : "pointer", fontSize: 12, color: "#333", opacity: page <= 1 ? 0.4 : 1 }}>
                    ‹ Prev
                  </button>
                  <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                    style={{ padding: "5px 12px", border: "1px solid #e0e0e0", borderRadius: 4, background: "#fff", cursor: page >= totalPages ? "default" : "pointer", fontSize: 12, color: "#333", opacity: page >= totalPages ? 0.4 : 1 }}>
                    Next ›
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add/Edit modal */}
      {showModal && (
        <Modal
          title={editItem ? "Edit Option" : "Add Addendum Default"}
          onClose={() => setShowModal(false)}
          footer={
            <>
              {formError && <span style={{ fontSize: 12, color: "#ff5252", flex: 1 }}>{formError}</span>}
              <button onClick={() => setShowModal(false)} style={btnGhost}>Cancel</button>
              <button onClick={() => void handleSave()} disabled={saving} style={btnPrimary}>
                {saving ? "Saving…" : editItem ? "Save Changes" : "Add Option"}
              </button>
            </>
          }
        >
          <OptionForm
            form={form} setForm={setForm}
            appliesTo={appliesTo} setAppliesTo={setAppliesTo}
            showPriceHelp={showPriceHelp} setShowPriceHelp={setShowPriceHelp}
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

      {/* Price help popover */}
      <PriceHelp open={showPriceHelp} onClose={() => setShowPriceHelp(false)} />
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
