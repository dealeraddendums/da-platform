"use client";

// Shared product-authoring fields — Item Name (+ image), Price (+ "?" helper),
// and Description (AI Generate, font-size "A" toggle, rich text, add-image).
// Used by BOTH the dealer Configure Product modal (OptionsLibrary) and the
// group Add Corporate Product modal (CorporateProductModal) so the two stay in
// parity. Self-contained: owns its own AI / image-picker / price-help state.
//
// Product images are plain S3 URLs in the shared `addendum-product-images`
// bucket embedded into the name/description HTML — not image_library rows — so
// an image authored on a corporate product renders on every member dealer's
// addendum automatically (RichName's sanitizer allow-lists that host).

import { useState } from "react";
import RichTextEditor from "@/components/RichTextEditor";
import ImageUploadPicker from "@/components/ImageUploadPicker";
import { RichName } from "@/lib/product-name";

const inp: React.CSSProperties = {
  width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4,
  fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", background: "#fff",
};
const lbl: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: "#55595c", textTransform: "uppercase",
  letterSpacing: ".05em", display: "block", marginBottom: 5,
};
const btnGhost: React.CSSProperties = {
  padding: "7px 14px", background: "#fff", color: "#55595c",
  border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 13,
};

const PRICE_CODES: [string, string][] = [
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
    <div style={{ position: "fixed", inset: 0, zIndex: 2000 }}>
      <div
        style={{ position: "absolute", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 16, width: 320, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", top: "50%", left: "50%", transform: "translate(-50%,-50%)" }}
        onClick={(e) => e.stopPropagation()}
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

export interface ProductAuthoringFieldsProps {
  itemName: string;
  price: string;
  description: string;
  onItemName: (v: string) => void;
  onPrice: (v: string) => void;
  onDescription: (v: string) => void;
  /** Organizational key prefix for uploaded images (e.g. "group/{id}"). The
   *  image library + rendering are shared across the platform regardless. */
  imageKeyPrefix?: string;
  /** Extra context appended to the AI generation request. */
  aiContext?: string;
  pricePlaceholder?: string;
}

export default function ProductAuthoringFields({
  itemName, price, description, onItemName, onPrice, onDescription,
  imageKeyPrefix, aiContext, pricePlaceholder = "e.g. 799 or NC or FR",
}: ProductAuthoringFieldsProps) {
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [insertTarget, setInsertTarget] = useState<"description" | "item_name">("description");
  const [descToolbarOpen, setDescToolbarOpen] = useState(false);
  const [showPriceHelp, setShowPriceHelp] = useState(false);

  async function handleAiGenerate() {
    const name = itemName.trim();
    if (!name) { setAiError("Enter an item name first"); return; }
    setAiGenerating(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai-content/option-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemName: name, price, context: aiContext }),
      });
      const text = await res.text();
      let json: { description?: string; error?: string } = {};
      try { json = JSON.parse(text) as typeof json; } catch { /* non-JSON */ }
      if (!res.ok) { setAiError(json.error ?? `Generation failed (HTTP ${res.status})`); return; }
      const desc = json.description ?? "";
      const html = /<[a-z][^>]*>/i.test(desc)
        ? desc
        : (desc ? `<p>${desc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>")}</p>` : "");
      onDescription(html);
      setAiGenerated(true);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Network error");
    } finally { setAiGenerating(false); }
  }

  return (
    <>
      {/* Item Name */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Item Name *</label>
        <input value={itemName} onChange={(e) => onItemName(e.target.value)} style={inp} placeholder="e.g. Ceramic Tint" />
        {itemName && /<img\b/i.test(itemName) && (
          <div style={{ marginTop: 6, padding: "6px 10px", background: "#f5f6f7", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 12 }}>
            <span style={{ color: "#78828c", marginRight: 6, fontSize: 11 }}>Preview:</span>
            <RichName name={itemName} imgMaxH={40} />
          </div>
        )}
      </div>

      {/* Price */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Price</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={price} onChange={(e) => onPrice(e.target.value)} style={{ ...inp, flex: 1 }} placeholder={pricePlaceholder} />
          <button type="button" onClick={() => setShowPriceHelp(true)}
            style={{ width: 28, height: 28, borderRadius: "50%", background: "#e3f2fd", border: "none", cursor: "pointer", color: "#1976d2", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
            ?
          </button>
        </div>
      </div>

      {/* Description */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5, gap: 8 }}>
          <label style={lbl}>Description</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={() => void handleAiGenerate()} disabled={aiGenerating}
              style={{ background: "none", border: "none", cursor: aiGenerating ? "default" : "pointer", color: "#1565c0", fontSize: 12, fontWeight: 700, padding: "2px 6px", display: "flex", alignItems: "center", gap: 3 }}>
              {aiGenerating ? "Generating…" : "✦ Generate"}
            </button>
            <button type="button" onClick={() => setDescToolbarOpen((o) => !o)}
              title={descToolbarOpen ? "Hide formatting" : "Show formatting"}
              style={{ height: 22, padding: "0 8px", fontSize: 12, fontWeight: 700, border: "1px solid #e0e0e0", borderRadius: 6, background: descToolbarOpen ? "#1976d2" : "#fff", color: descToolbarOpen ? "#fff" : "#78828c", cursor: "pointer", lineHeight: 1 }}>
              A
            </button>
          </div>
        </div>
        <RichTextEditor
          value={description}
          onChange={(html) => { onDescription(html); setAiGenerated(false); }}
          placeholder={aiGenerating ? "Generating description…" : "Optional description shown under the product name"}
          disabled={aiGenerating}
          minHeight={64}
          toolbarOpen={descToolbarOpen}
        />
        {aiGenerated && !aiGenerating && (
          <p style={{ fontSize: 11, color: "#1565c0", marginTop: 4, marginBottom: 0 }}>✦ AI generated — edit as needed</p>
        )}
        {aiError && <p style={{ fontSize: 11, color: "#c62828", marginTop: 4, marginBottom: 0 }}>{aiError}</p>}
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <button type="button" onClick={() => { setInsertTarget("description"); setShowImagePicker(true); }}
            style={{ padding: "4px 10px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 11, color: "#55595c", fontWeight: 600 }}>
            ＋ Add image to description
          </button>
          <button type="button" onClick={() => { setInsertTarget("item_name"); setShowImagePicker(true); }}
            style={{ padding: "4px 10px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer", fontSize: 11, color: "#55595c", fontWeight: 600 }}>
            ＋ Add image to item name
          </button>
        </div>
      </div>

      {showImagePicker && (
        <ImageUploadPicker
          title="Product Image Library"
          tab1Label="Library"
          listEndpoint="/api/upload-image?bucket=addendum-product-images"
          uploadBucket="addendum-product-images"
          uploadKeyPrefix={imageKeyPrefix}
          acceptedTypes="image/png,image/jpeg,image/jpg,image/gif,image/webp"
          maxSizeMB={5}
          requestAlt
          onSelect={(url, meta) => {
            const altAttr = (meta?.alt ?? "").replace(/"/g, "&quot;");
            const tag = `<img src="${url}" alt="${altAttr}" width="125" style="max-width:125px;" />`;
            if (insertTarget === "item_name") onItemName(itemName + tag);
            else onDescription(description + tag);
            setShowImagePicker(false);
          }}
          onClose={() => setShowImagePicker(false)}
        />
      )}

      <PriceHelp open={showPriceHelp} onClose={() => setShowPriceHelp(false)} />
    </>
  );
}
