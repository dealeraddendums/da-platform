"use client";

import { useEffect, useState } from "react";

// Dealer-facing config for the public Website Integrations widget (Dealer.com).
// Self-contained: fetches/saves /api/settings/website-integrations. Mirrors the
// server's PLATFORM_BUTTON_CSS as the prefill/placeholder default (kept in sync
// with lib/website-integrations.ts — this copy is client-safe, no server imports).
const DEFAULT_BUTTON_CSS = `.dealer-addendums__button__download-button {
  display: inline-block;
  background-color: #1976d2;
  color: #ffffff;
  padding: 10px 20px;
  border-radius: 4px;
  text-decoration: none;
  font-family: sans-serif;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dealer-addendums__button__download-button:hover { background-color: #1565c0; }`;

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 600, color: "#55595c", marginBottom: 4, marginTop: 14 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" };

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function snippetFor(): string {
  // Fetch-and-inject (the legacy widget's method) — works cross-origin via the
  // endpoint's Access-Control-Allow-Origin: *. (Do NOT iframe it — the app sends
  // X-Frame-Options: DENY, which blocks frame embedding.)
  return `<div id="da-addendum-widget"></div>
<script>
document.addEventListener("Vehicle Shown V1", function (e) {
  var vin = (e.detail && e.detail.vin) || '';
  if (!vin) return;
  fetch('https://api.dealeraddendums.com/generate-addendum/' + vin + '/dealer-addendums-theme?feature=both')
    .then(function (r) { return r.text(); })
    .then(function (html) {
      document.getElementById('da-addendum-widget').innerHTML = html;
    });
});
</script>`;
}

export default function WebsiteIntegrationsTab({ dealerId, role }: { dealerId: string; role: string }) {
  // dealer_admin acts on its own dealer (no param); group_admin/super_admin pass dealer_id.
  const qs = role === "dealer_admin" ? "" : `?dealer_id=${encodeURIComponent(dealerId)}`;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [enabled, setEnabled] = useState(true);
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
        body: JSON.stringify({ provider: "dealer_com", enabled, button_label: buttonLabel, button_css: buttonCss || null }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
    }
  }

  const effectiveCss = buttonCss.trim() || DEFAULT_BUTTON_CSS;
  const previewHtml = `<style>${effectiveCss}</style><a href="#" onclick="return false" class="dealer-addendums__button__download-button">${escapeHtml(buttonLabel || "Download Addendum")}</a>`;

  if (loading) {
    return <div style={{ padding: 24, color: "#78828c", fontSize: 13 }}>Loading…</div>;
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "20px 24px", fontFamily: "Roboto, sans-serif" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#2a2b3c", marginBottom: 4 }}>Dealer.com</div>
        <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.6, marginBottom: 16 }}>
          Customize the &ldquo;Download Addendum&rdquo; button and pricing widget shown on your Dealer.com vehicle pages.
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span style={{ fontSize: 14, color: "#333" }}>Enabled — show the widget on this dealer&apos;s vehicle pages</span>
        </label>

        <label style={labelStyle}>Button Label</label>
        <input value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} placeholder="Download Addendum" style={inputStyle} />

        <label style={labelStyle}>Button CSS</label>
        <textarea
          value={buttonCss}
          onChange={(e) => setButtonCss(e.target.value)}
          rows={8}
          placeholder={DEFAULT_BUTTON_CSS}
          style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
        />
        <div style={{ fontSize: 11, color: "#78828c", marginTop: 4 }}>Leave blank to use the platform default styling.</div>

        <label style={labelStyle}>Live Preview</label>
        <div
          style={{ border: "1px dashed #e0e0e0", borderRadius: 4, padding: 20, background: "#fafafa" }}
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
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

      <div style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: "20px 24px", marginTop: 16, fontFamily: "Roboto, sans-serif" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#2a2b3c", marginBottom: 6 }}>Website Snippet (Dealer.com)</div>
        <div style={{ fontSize: 13, color: "#55595c", lineHeight: 1.6, marginBottom: 10 }}>
          Add this to your Dealer.com VDP. It injects the widget for the vehicle being viewed — the VIN is filled in at runtime.
          The exact integration method varies by Dealer.com account; your web admin can adapt it (e.g. via <code>API.insertCallToAction()</code>).
        </div>
        <pre style={{ background: "#f5f6f7", border: "1px solid #e0e0e0", borderRadius: 4, padding: 12, fontSize: 12, fontFamily: "monospace", overflowX: "auto", whiteSpace: "pre", color: "#333", margin: 0 }}>{snippetFor()}</pre>
      </div>
    </div>
  );
}
