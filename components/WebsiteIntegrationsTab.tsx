"use client";

import { useEffect, useRef, useState } from "react";

// Dealer-facing config for the public Website Integrations widget (Dealer.com).
// Dealer.com already has our API endpoint registered as an approved integration,
// so there is no per-dealer snippet to generate. The only per-dealer config is:
//   1. enabled toggle
//   2. feature — Magic Button ('button') | Pricing Stack ('pricing') | Both ('both')
//   3. button label (only relevant when the Magic Button is shown)
//   4. button CSS — custom styles for the Download Addendum button (optional;
//      can be generated from a screenshot of the dealer's site via Claude vision)
// Self-contained: fetches/saves /api/settings/website-integrations.

type Feature = "button" | "pricing" | "both";

const FEATURE_OPTIONS: { value: Feature; label: string; hint: string }[] = [
  { value: "button", label: "Magic Button", hint: "A “Download Addendum” button on the vehicle page." },
  { value: "pricing", label: "Pricing Stack", hint: "The itemized pricing/options widget on the vehicle page." },
  { value: "both", label: "Both", hint: "Show the Magic Button and the Pricing Stack." },
];

const CSS_PLACEHOLDER = `.dealer-addendums__button__download-button {
  background-color: #1976d2;
  color: #ffffff;
  padding: 10px 20px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 14px;
  text-decoration: none;
  display: inline-block;
  cursor: pointer;
}`;

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4, marginTop: 18 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };

export default function WebsiteIntegrationsTab({ dealerId, role }: { dealerId: string; role: string }) {
  // dealer_admin acts on its own dealer (no param); group_admin/super_admin pass dealer_id.
  const qs = role === "dealer_admin" ? "" : `?dealer_id=${encodeURIComponent(dealerId)}`;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [enabled, setEnabled] = useState(true);
  const [feature, setFeature] = useState<Feature>("both");
  const [buttonLabel, setButtonLabel] = useState("Download Addendum");
  const [buttonCss, setButtonCss] = useState("");

  // AI CSS generation from a screenshot.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [genNote, setGenNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings/website-integrations${qs}`);
        const json = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && json.data) {
          setEnabled(json.data.enabled ?? true);
          setFeature((json.data.feature as Feature) || "both");
          setButtonLabel(json.data.button_label || "Download Addendum");
          setButtonCss(json.data.button_css || "");
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qs]);

  async function save() {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const res = await fetch(`/api/settings/website-integrations${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "dealer_com", enabled, feature, button_label: buttonLabel, button_css: buttonCss }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  async function onScreenshotSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again still fires onChange.
    e.target.value = "";
    if (!file) return;

    setGenerating(true);
    setGenError("");
    setGenNote("");
    try {
      const form = new FormData();
      form.append("screenshot", file);
      const res = await fetch(`/api/settings/website-integrations/generate-css`, {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.css) {
        setButtonCss(json.css);
        setGenNote("CSS generated — review and save.");
      } else {
        setGenError(json.error || "Could not generate CSS from this image");
      }
    } catch {
      setGenError("Could not generate CSS from this image");
    } finally {
      setGenerating(false);
    }
  }

  const showButtonLabel = feature === "button" || feature === "both";

  if (loading) {
    return <div style={{ padding: 24, color: "#78828c", fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "20px 24px", fontFamily: "Roboto, sans-serif" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#2a2b3c", marginBottom: 4 }}>Dealer.com</div>
        <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.6, marginBottom: 16 }}>
          Control how DealerAddendums appears on your Dealer.com vehicle pages. The integration is already approved on
          Dealer.com&apos;s side — just choose what to show here.
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span style={{ fontSize: 14, color: "#333" }}>Enabled — show on this dealer&apos;s vehicle pages</span>
        </label>

        <label style={labelStyle}>What to show</label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 2 }}>
          {FEATURE_OPTIONS.map((opt) => (
            <label key={opt.value} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="radio"
                name="wi-feature"
                value={opt.value}
                checked={feature === opt.value}
                onChange={() => setFeature(opt.value)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontSize: 14, color: "#333", fontWeight: 600 }}>{opt.label}</span>
                <span style={{ display: "block", fontSize: 12, color: "#78828c" }}>{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>

        {showButtonLabel && (
          <>
            <label style={labelStyle}>Button Label</label>
            <input
              value={buttonLabel}
              onChange={(e) => setButtonLabel(e.target.value)}
              placeholder="Download Addendum"
              style={inputStyle}
            />
            <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>Text shown on the Magic Button. Leave as-is for the default.</div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18, marginBottom: 4 }}>
              <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0 }}>Button Style (Custom CSS)</label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={generating}
                style={{
                  background: "#fff",
                  color: "#1976d2",
                  border: "1px solid #1976d2",
                  borderRadius: 4,
                  padding: "5px 10px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: generating ? "wait" : "pointer",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                {generating ? "Analyzing your website…" : "✨ Generate from screenshot"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onScreenshotSelected}
                style={{ display: "none" }}
              />
            </div>
            <textarea
              value={buttonCss}
              onChange={(e) => setButtonCss(e.target.value)}
              placeholder={CSS_PLACEHOLDER}
              rows={6}
              spellCheck={false}
              style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
            />
            <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
              Paste CSS to style the Download Addendum button to match your website. Leave blank for the default style.
            </div>
            {genNote && <div style={{ fontSize: 12, color: "#15803D", marginTop: 6 }}>✓ {genNote}</div>}
            {genError && <div style={{ fontSize: 12, color: "#c62828", marginTop: 6 }}>{genError}</div>}
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 24 }}>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, padding: "9px 20px", fontSize: 14, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saveStatus === "saved" && <span style={{ fontSize: 13, color: "#15803D" }}>✓ Saved</span>}
          {saveStatus === "error" && <span style={{ fontSize: 13, color: "#c62828" }}>Save failed — please try again.</span>}
        </div>
      </div>
    </div>
  );
}
