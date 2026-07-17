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
  buttonCss, setButtonCss, helperText, target = "button",
}: {
  buttonCss: string;
  setButtonCss: (v: string) => void;
  helperText: string;
  /** Passed to the generate-css endpoint so the vision prompt targets the
   *  right selector ("button" → download-button, "icon" → icon-button). */
  target?: "button" | "icon";
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [genNote, setGenNote] = useState("");
  // "Match from URL": reads exact computed styles from the dealer's live page
  // (da-pdf-service Puppeteer) — precise where the screenshot generator guesses.
  const [matchOpen, setMatchOpen] = useState(false);
  const [matchUrl, setMatchUrl] = useState("");
  const [matchText, setMatchText] = useState("");
  const [matching, setMatching] = useState(false);

  async function onMatchFromUrl() {
    if (!matchUrl.trim() || !matchText.trim() || matching) return;
    setMatching(true);
    setGenError("");
    setGenNote("");
    try {
      const res = await fetch(`/api/settings/website-integrations/match-from-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: matchUrl.trim(),
          buttonText: matchText.trim(),
          targetClass: target === "icon" ? ".dealer-addendums__button__icon-button" : ".dealer-addendums__button__download-button",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.css) {
        setButtonCss(json.css);
        setGenNote(`Matched the "${json.matched?.text ?? matchText.trim()}" button on your page — review and save.`);
        setMatchOpen(false);
      } else {
        setGenError(json.error || "We couldn't read that page. Try the screenshot method instead.");
      }
    } catch {
      setGenError("We couldn't read that page. Try the screenshot method instead.");
    } finally {
      setMatching(false);
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
      form.append("target", target);
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18, marginBottom: 4, flexWrap: "wrap" }}>
        <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0 }}>Button Style (Custom CSS)</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => { setMatchOpen((v) => !v); setGenError(""); setGenNote(""); }}
            disabled={matching}
            style={{ background: matchOpen ? "#eef4fb" : "#fff", color: "#1976d2", border: "1px solid #1976d2", borderRadius: 4, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
          >
            🔗 Match a button on your site
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={generating}
            style={{ background: "#fff", color: "#1976d2", border: "1px solid #1976d2", borderRadius: 4, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: generating ? "wait" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
          >
            {generating ? "Analyzing your website…" : "✨ Generate from screenshot"}
          </button>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={onScreenshotSelected} style={{ display: "none" }} />
      </div>
      {matchOpen && (
        <div style={{ border: "1px solid #e0e0e0", borderRadius: 4, padding: 12, marginBottom: 8, background: "#fafbfc" }}>
          <input
            type="url"
            value={matchUrl}
            onChange={(e) => setMatchUrl(e.target.value)}
            placeholder="Page URL (a vehicle page on your website)"
            style={{ ...inputStyle, fontSize: 13, marginBottom: 8 }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={matchText}
              onChange={(e) => setMatchText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onMatchFromUrl(); }}
              placeholder='Text of the button to match (e.g. "Window Sticker")'
              maxLength={120}
              style={{ ...inputStyle, fontSize: 13, flex: 1 }}
            />
            <button
              type="button"
              onClick={onMatchFromUrl}
              disabled={matching || !matchUrl.trim() || !matchText.trim()}
              style={{ background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: matching ? "wait" : "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
            >
              {matching ? "Reading your page…" : "Match"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#78828c", marginTop: 6 }}>
            We&apos;ll read the exact styles from your live page.
          </div>
        </div>
      )}
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
      <IconButtonCard qs={qs} />
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
  // A dealer who never saved gets API defaults (updated_at null) — the header
  // hint shows "Not configured" instead of implying an explicit "Enabled".
  const [configured, setConfigured] = useState(false);

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
          setConfigured(!!json.data.updated_at);
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
      if (res.ok) setConfigured(true);
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  const showButtonLabel = feature === "button" || feature === "both";
  const hint = loading ? "…" : !configured ? "Not configured" : enabled ? `Enabled · ${FEATURE_LABEL[feature]}` : "Not enabled";

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

// ── Icon Button API card ─────────────────────────────────────────────────────
// Compact icon-style button (?feature=icon — e.g. a red circle with a white
// "?") that behaves exactly like the Magic Button. provider='api_icon';
// button_label holds the icon character. The graphical designer WRITES CSS
// into the textarea below — the textarea stays the source of truth (advanced
// users can hand-edit after), and the live preview renders whatever the
// textarea currently holds.

type IconShape = "circle" | "rounded" | "square";
type IconShadow = "none" | "subtle" | "strong";
interface IconDesign {
  shape: IconShape;
  size: number;
  bg: string;
  fg: string;
  borderWidth: number;
  borderColor: string;
  shadow: IconShadow;
  hoverBg: string;
}
const DEFAULT_DESIGN: IconDesign = { shape: "circle", size: 32, bg: "#1976d2", fg: "#ffffff", borderWidth: 0, borderColor: "#000000", shadow: "none", hoverBg: "#1565c0" };

function buildIconCss(d: IconDesign): string {
  const radius = d.shape === "circle" ? "50%" : d.shape === "rounded" ? "8px" : "0";
  const shadow = d.shadow === "none" ? "none" : d.shadow === "subtle" ? "0 1px 3px rgba(0,0,0,0.25)" : "0 2px 8px rgba(0,0,0,0.4)";
  const border = d.borderWidth > 0 ? `${d.borderWidth}px solid ${d.borderColor}` : "none";
  return `.dealer-addendums__button__icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: ${d.size}px;
  height: ${d.size}px;
  border-radius: ${radius};
  background-color: ${d.bg};
  color: ${d.fg};
  font-family: sans-serif;
  font-size: ${Math.round(d.size * 0.5)}px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  border: ${border};
  box-shadow: ${shadow};
}
.dealer-addendums__button__icon-button:hover { background-color: ${d.hoverBg}; }`;
}

const designerLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: "#55595c", display: "block", marginBottom: 3 };
const segBtn = (active: boolean): React.CSSProperties => ({
  padding: "4px 10px", fontSize: 12, fontFamily: "inherit", cursor: "pointer",
  border: `1px solid ${active ? "#1976d2" : "#e0e0e0"}`, background: active ? "#e3f2fd" : "#fff",
  color: active ? "#1976d2" : "#55595c", fontWeight: active ? 600 : 400,
});

function IconButtonCard({ qs }: { qs: string }) {
  const sep = qs ? "&" : "?";
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [iconChar, setIconChar] = useState("?");
  const [buttonCss, setButtonCss] = useState("");
  const [embedDealerId, setEmbedDealerId] = useState("");
  const [copied, setCopied] = useState(false);
  const [design, setDesign] = useState<IconDesign>(DEFAULT_DESIGN);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings/website-integrations${qs}${sep}provider=api_icon`);
        const json = await res.json().catch(() => ({}));
        if (!cancelled && res.ok && json.data) {
          setIconChar(json.data.button_label || "?");
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

  // Designer control change → update state AND write the generated CSS into
  // the textarea (which drives the preview and is what gets saved).
  function applyDesign(patch: Partial<IconDesign>) {
    setDesign((prev) => {
      const next = { ...prev, ...patch };
      setButtonCss(buildIconCss(next));
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSaveStatus("idle");
    try {
      const res = await fetch(`/api/settings/website-integrations${qs}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "api_icon", button_label: iconChar, button_css: buttonCss }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  const embedLink = `https://api.dealeraddendums.com/generate-addendum/{VIN}/default?feature=icon${embedDealerId ? `&dealer=${encodeURIComponent(embedDealerId)}` : ""}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(embedLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the field is selectable */
    }
  }

  // Preview injects the textarea CSS into this admin page — strip '<' so a
  // pasted </style> can't break out (mirrors the serve-time sanitizer).
  const previewCss = (buttonCss || "").replace(/</g, "");
  const hint = loading ? "…" : buttonCss ? "Custom style set" : "Default style";

  return (
    <IntegrationCard title="Icon Button API" hint={hint}>
      <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.6, marginBottom: 4 }}>
        A small icon-style button (like a &quot;?&quot; badge) you can place anywhere on your vehicle pages. It opens the
        same addendum PDF as the Magic Button — use both on one page with different styling.
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

      <label style={labelStyle}>Icon character</label>
      <input
        value={iconChar}
        onChange={(e) => setIconChar(e.target.value)}
        placeholder="?"
        maxLength={4}
        style={{ ...inputStyle, width: 90, textAlign: "center", fontWeight: 700 }}
      />
      <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>Shown inside the button — “?”, “i”, “$”, or an emoji. Keep it short.</div>

      {/* Designer + live preview */}
      <label style={labelStyle}>Button designer</label>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", border: "1px solid #e0e0e0", borderRadius: 4, padding: "12px 14px", background: "#fafafa" }}>
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
          <div>
            <span style={designerLabel}>Shape</span>
            <div style={{ display: "inline-flex" }}>
              {(["circle", "rounded", "square"] as IconShape[]).map((s, i) => (
                <button key={s} type="button" onClick={() => applyDesign({ shape: s })}
                  style={{ ...segBtn(design.shape === s), borderRadius: i === 0 ? "4px 0 0 4px" : i === 2 ? "0 4px 4px 0" : 0, marginLeft: i > 0 ? -1 : 0 }}>
                  {s === "circle" ? "Circle" : s === "rounded" ? "Rounded" : "Square"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span style={designerLabel}>Size — {design.size}px</span>
            <input type="range" min={24} max={64} step={2} value={design.size} onChange={(e) => applyDesign({ size: parseInt(e.target.value, 10) })} style={{ width: "100%" }} />
          </div>
          <div>
            <span style={designerLabel}>Background</span>
            <input type="color" value={design.bg} onChange={(e) => applyDesign({ bg: e.target.value })} style={{ width: 44, height: 28, padding: 0, border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer" }} />
          </div>
          <div>
            <span style={designerLabel}>Icon color</span>
            <input type="color" value={design.fg} onChange={(e) => applyDesign({ fg: e.target.value })} style={{ width: 44, height: 28, padding: 0, border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer" }} />
          </div>
          <div>
            <span style={designerLabel}>Border — {design.borderWidth === 0 ? "none" : `${design.borderWidth}px`}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="range" min={0} max={4} value={design.borderWidth} onChange={(e) => applyDesign({ borderWidth: parseInt(e.target.value, 10) })} style={{ flex: 1 }} />
              <input type="color" value={design.borderColor} onChange={(e) => applyDesign({ borderColor: e.target.value })} style={{ width: 32, height: 24, padding: 0, border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer" }} />
            </div>
          </div>
          <div>
            <span style={designerLabel}>Shadow</span>
            <div style={{ display: "inline-flex" }}>
              {(["none", "subtle", "strong"] as IconShadow[]).map((s, i) => (
                <button key={s} type="button" onClick={() => applyDesign({ shadow: s })}
                  style={{ ...segBtn(design.shadow === s), borderRadius: i === 0 ? "4px 0 0 4px" : i === 2 ? "0 4px 4px 0" : 0, marginLeft: i > 0 ? -1 : 0 }}>
                  {s === "none" ? "None" : s === "subtle" ? "Subtle" : "Strong"}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span style={designerLabel}>Hover background</span>
            <input type="color" value={design.hoverBg} onChange={(e) => applyDesign({ hoverBg: e.target.value })} style={{ width: 44, height: 28, padding: 0, border: "1px solid #e0e0e0", borderRadius: 4, cursor: "pointer" }} />
          </div>
        </div>

        {/* Live preview — renders whatever CSS the textarea currently holds */}
        <div style={{ width: 130, textAlign: "center", flexShrink: 0 }}>
          <span style={designerLabel}>Preview</span>
          <div style={{ background: "#fff", border: "1px dashed #e0e0e0", borderRadius: 4, padding: "18px 8px", minHeight: 76, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <style>{previewCss}</style>
            <a
              href="#preview"
              onClick={(e) => e.preventDefault()}
              className="dealer-addendums__button__icon-button"
              aria-label="Download Addendum"
              title="Download Addendum"
              style={previewCss ? undefined : { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: "50%", backgroundColor: "#1976d2", color: "#fff", fontFamily: "sans-serif", fontSize: 16, fontWeight: 700, textDecoration: "none" }}
            >
              {iconChar.trim() || "?"}
            </a>
          </div>
          <div style={{ fontSize: 10, color: "#78828c", marginTop: 4 }}>Hover to test the hover color</div>
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>
        The designer writes CSS into the box below — fine-tune by hand there if you like.
      </div>

      <CssEditor
        buttonCss={buttonCss}
        setButtonCss={setButtonCss}
        target="icon"
        helperText="This CSS styles the icon button. Leave blank for the default blue circle. Changes may take up to 5 minutes to appear on your website."
      />

      <SaveRow saving={saving} saveStatus={saveStatus} onSave={() => void save()} />
    </IntegrationCard>
  );
}
