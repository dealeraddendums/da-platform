"use client";

import { useEffect, useRef, useState } from "react";

// Dealer-facing config for the public Website Integrations widgets.
// Two cards (more coming — all load COLLAPSED, matching Print Settings):
//   • Dealer.com — enabled toggle, feature picker, label, custom CSS
//   • Generate Button API — label + custom CSS for dealers embedding the
//     direct api.dealeraddendums.com link on their own site (provider='api')
// Both save through /api/settings/website-integrations; the CSS generator
// endpoint is shared.

type Feature = "button" | "pricing" | "both";

const FEATURE_OPTIONS: { value: Feature; label: string; hint: string }[] = [
  { value: "button", label: "Magic Button", hint: "A “Download Addendum” button on the vehicle page." },
  { value: "pricing", label: "Pricing Stack", hint: "The itemized pricing/options widget on the vehicle page." },
  { value: "both", label: "Both", hint: "Show the Magic Button and the Pricing Stack." },
];
const FEATURE_LABEL: Record<Feature, string> = { button: "Magic Button", pricing: "Pricing Stack", both: "Both" };

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

// Collapsible card shell — clickable header + chevron, collapsed by default
// (CollapsibleCardHeader pattern from SettingsForm, 2026-07-05). The status
// hint keeps the collapsed row informative at a glance.
function IntegrationCard({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "16px 24px", fontFamily: "Roboto, sans-serif", marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}
      >
        <span style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#2a2b3c" }}>{title}</span>
          <span style={{ fontSize: 12, color: "#78828c", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</span>
        </span>
        <span style={{ color: "#78828c", fontSize: 12, transition: "transform 150ms", display: "inline-block", transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}>▼</span>
      </button>
      {!collapsed && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

// Shared Custom CSS block: textarea + screenshot→CSS generator (same endpoint
// for every card) + helper text.
function CssEditor({
  buttonCss, setButtonCss, helperText,
}: {
  buttonCss: string;
  setButtonCss: (v: string) => void;
  helperText: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [genNote, setGenNote] = useState("");

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
      const res = await fetch(`/api/settings/website-integrations/generate-css`, { method: "POST", body: form });
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

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18, marginBottom: 4 }}>
        <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0 }}>Button Style (Custom CSS)</label>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={generating}
          style={{ background: "#fff", color: "#1976d2", border: "1px solid #1976d2", borderRadius: 4, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: generating ? "wait" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
        >
          {generating ? "Analyzing your website…" : "✨ Generate from screenshot"}
        </button>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={onScreenshotSelected} style={{ display: "none" }} />
      </div>
      <textarea
        value={buttonCss}
        onChange={(e) => setButtonCss(e.target.value)}
        placeholder={CSS_PLACEHOLDER}
        rows={6}
        spellCheck={false}
        style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12, lineHeight: 1.5, resize: "vertical" }}
      />
      <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>{helperText}</div>
      {genNote && <div style={{ fontSize: 12, color: "#15803D", marginTop: 6 }}>✓ {genNote}</div>}
      {genError && <div style={{ fontSize: 12, color: "#c62828", marginTop: 6 }}>{genError}</div>}
    </>
  );
}

function SaveRow({ saving, saveStatus, onSave }: { saving: boolean; saveStatus: "idle" | "saved" | "error"; onSave: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 24 }}>
      <button
        onClick={onSave}
        disabled={saving}
        style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, padding: "9px 20px", fontSize: 14, fontWeight: 600, cursor: saving ? "wait" : "pointer", fontFamily: "inherit" }}
      >
        {saving ? "Saving…" : "Save"}
      </button>
      {saveStatus === "saved" && <span style={{ fontSize: 13, color: "#15803D" }}>✓ Saved</span>}
      {saveStatus === "error" && <span style={{ fontSize: 13, color: "#c62828" }}>Save failed — please try again.</span>}
    </div>
  );
}

export default function WebsiteIntegrationsTab({ dealerId, role }: { dealerId: string; role: string }) {
  // dealer_admin acts on its own dealer (no param); group_admin/super_admin pass dealer_id.
  const qs = role === "dealer_admin" ? "" : `?dealer_id=${encodeURIComponent(dealerId)}`;
  return (
    <div style={{ maxWidth: 640 }}>
      <DealerComCard qs={qs} />
      <ApiButtonCard qs={qs} />
    </div>
  );
}

// ── Dealer.com card ──────────────────────────────────────────────────────────
function DealerComCard({ qs }: { qs: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [enabled, setEnabled] = useState(true);
  const [feature, setFeature] = useState<Feature>("both");
  const [buttonLabel, setButtonLabel] = useState("Download Addendum");
  const [buttonCss, setButtonCss] = useState("");

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

  const showButtonLabel = feature === "button" || feature === "both";
  const hint = loading ? "…" : enabled ? `Enabled · ${FEATURE_LABEL[feature]}` : "Not enabled";

  return (
    <IntegrationCard title="Dealer.com" hint={hint}>
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
          <input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder="Download Addendum" style={inputStyle} />
          <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>Text shown on the Magic Button. Leave as-is for the default.</div>

          <CssEditor
            buttonCss={buttonCss}
            setButtonCss={setButtonCss}
            helperText="Paste CSS to style the Download Addendum button to match your website. Leave blank for the default style."
          />
        </>
      )}

      <SaveRow saving={saving} saveStatus={saveStatus} onSave={() => void save()} />
    </IntegrationCard>
  );
}

// ── Generate Button API card ─────────────────────────────────────────────────
// For dealers embedding the direct API link on their own website. Stores a
// dealer_website_integrations row with provider='api' (no Enabled toggle —
// usage is opt-in by embedding the link). The public widget routes prefer
// this row over the Dealer.com one when both exist.
function ApiButtonCard({ qs }: { qs: string }) {
  const sep = qs ? "&" : "?";
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [buttonLabel, setButtonLabel] = useState("Download Addendum");
  const [buttonCss, setButtonCss] = useState("");
  const [embedDealerId, setEmbedDealerId] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings/website-integrations${qs}${sep}provider=api`);
        const json = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && json.data) {
          setButtonLabel(json.data.button_label || "Download Addendum");
          setButtonCss(json.data.button_css || "");
          setEmbedDealerId(json.embed_dealer_id || "");
        }
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qs, sep]);

  async function save() {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const res = await fetch(`/api/settings/website-integrations${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "api", button_label: buttonLabel, button_css: buttonCss }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  const embedLink = `https://api.dealeraddendums.com/generate-addendum/{VIN}/default?feature=button${embedDealerId ? `&dealer=${encodeURIComponent(embedDealerId)}` : ""}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(embedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the field is selectable */
    }
  }

  const hint = loading ? "…" : buttonCss ? "Custom CSS set" : "Default style";

  return (
    <IntegrationCard title="Generate Button API" hint={hint}>
      <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.6, marginBottom: 4 }}>
        Style the Download Addendum button served by the DealerAddendums API (api.dealeraddendums.com) when embedded
        directly on your website.
      </div>

      <label style={labelStyle}>Your API link</label>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <input
          readOnly
          value={embedLink}
          onFocus={(e) => e.target.select()}
          style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12, color: "#333", background: "#fafafa" }}
        />
        <button
          type="button"
          onClick={() => void copyLink()}
          style={{ background: "#fff", color: "#1976d2", border: "1px solid #1976d2", borderRadius: 4, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
        Replace {"{VIN}"} with the vehicle&apos;s VIN — most website providers support a VIN template variable.
      </div>

      <label style={labelStyle}>Button Label</label>
      <input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder="Download Addendum" style={inputStyle} />
      <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
        Text shown on the button. This wins over a <code>?text=</code> value in the embed link.
      </div>

      <CssEditor
        buttonCss={buttonCss}
        setButtonCss={setButtonCss}
        helperText="Paste CSS to style the button to match your website. Leave blank for the default style. Changes may take up to 5 minutes to appear on your website."
      />

      <SaveRow saving={saving} saveStatus={saveStatus} onSave={() => void save()} />
    </IntegrationCard>
  );
}
