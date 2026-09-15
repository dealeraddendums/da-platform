"use client";

import { useEffect, useRef, useState } from "react";
import { printPdfFromBlobUrl } from "@/lib/print-pdf";
import type { BuyersGuideDefaults } from "@/lib/db";

type Props = {
  dealerVehicleId: string;
  vehicleName: string;
  onClose: () => void;
  onPrinted?: () => void;
};

const WARRANTY_LABELS: Record<string, string> = {
  as_is: "As Is — No Dealer Warranty",
  implied_only: "Implied Warranties Only",
  full: "Full Warranty",
  limited: "Limited Warranty",
};

/** Which print buttons the footer offers. Saved per dealer in
 *  dealer_settings.buyers_guide_defaults.print_mode; switchable here for a
 *  single guide without touching the saved default. */
type PrintMode = "single_sides" | "both_sides";

const PRINT_MODE_LABELS: Record<PrintMode, string> = {
  single_sides: "Print Single Sides",
  both_sides: "Print Both Sides",
};

/** Which side(s) of the guide a generate call should hand back. */
type Side = "all" | "front" | "back";

const NON_DEALER = [
  { key: "mfr_new", label: "Manufacturer's new vehicle warranty still applies" },
  { key: "mfr_used", label: "Manufacturer's used vehicle warranty applies" },
  { key: "other_used", label: "Other used vehicle warranty applies" },
];

export default function BuyersGuideModal({ dealerVehicleId, vehicleName, onClose, onPrinted }: Props) {
  const [loading, setLoading] = useState(true);
  const [warranty, setWarranty] = useState<BuyersGuideDefaults>({ warranty_type: "as_is" });
  const [language, setLanguage] = useState<"en" | "es">("en");
  const [printMode, setPrintMode] = useState<PrintMode>("both_sides");
  /** Side of the last generated preview — drives the download filename. */
  const [side, setSide] = useState<Side>("all");
  const [generating, setGenerating] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokenRef = useRef<string | null>(null);
  const confirmedRef = useRef(false);

  // Record the print on the user's actual action (Send/Download or the
  // both-languages ZIP download) — generating a preview alone no longer
  // counts. Idempotent client- and server-side.
  async function confirmPrint() {
    if (confirmedRef.current) return;
    confirmedRef.current = true;
    const token = tokenRef.current;
    if (token) {
      try {
        await fetch("/api/print/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          keepalive: true,
        });
      } catch (e) {
        console.error("[buyers-guide] confirm failed:", e);
      }
    }
    onPrinted?.();
  }

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json() as Promise<{ data?: { buyers_guide_defaults?: BuyersGuideDefaults | null } }>)
      .then(j => {
        const bg = j.data?.buyers_guide_defaults;
        if (bg) {
          setWarranty({ ...bg });
          // Open in the dealer's saved print mode. Changing the toggle below
          // only affects this guide — the saved default lives in Print
          // Settings → Buyer's Guide.
          if (bg.print_mode === "single_sides" || bg.print_mode === "both_sides") {
            setPrintMode(bg.print_mode);
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!pdfUrl) return;
    if (pdfUrl.startsWith("blob:")) { setBlobUrl(pdfUrl); return; }
    let objectUrl: string;
    fetch(pdfUrl)
      .then(r => r.blob())
      .then(blob => { objectUrl = URL.createObjectURL(blob); setBlobUrl(objectUrl); });
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [pdfUrl]);

  function setW<K extends keyof BuyersGuideDefaults>(key: K, val: BuyersGuideDefaults[K]) {
    setWarranty(w => ({ ...w, [key]: val }));
  }

  function toggleNdw(key: string) {
    setWarranty(w => {
      const cur = w.non_dealer_warranties ?? [];
      return { ...w, non_dealer_warranties: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] };
    });
  }

  /**
   * mode:
   *   "single" — one language, into the preview
   *   "zip"    — both languages as a downloaded ZIP (unchanged)
   *   "merged" — both languages as ONE PDF into the preview, so "Send to
   *              Printer" gives a print dialog instead of a download
   *
   * opts.lang overrides the Language dropdown (the per-language print buttons
   * pass it explicitly, then move the dropdown to match so the preview label
   * and the download filename stay truthful). opts.side asks the server for
   * just the front or back page — every option on the left still applies, the
   * render is the same full guide, only the returned PDF is trimmed.
   */
  async function generate(
    mode: "single" | "zip" | "merged" = "single",
    opts: { lang?: "en" | "es"; side?: Side } = {},
  ) {
    const both = mode !== "single";
    const lang = opts.lang ?? language;
    const pages: Side = mode === "single" ? (opts.side ?? "all") : "all";
    if (opts.lang && opts.lang !== language) setLanguage(opts.lang);
    setSide(pages);
    setGenerating(true);
    setGenError(null);
    setPdfUrl(null);
    setBlobUrl(null);
    try {
      const body = { vehicleId: dealerVehicleId, language: lang, both, merge: mode === "merged", pages, warranty };
      const res = await fetch("/api/pdf/buyers-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (mode === "zip") {
        if (!res.ok) throw new Error("Generation failed");
        // The ZIP path downloads immediately — that IS the print action, so
        // record it right away.
        tokenRef.current = res.headers.get("X-Print-Token");
        confirmedRef.current = false;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${vehicleName.replace(/[^a-zA-Z0-9]+/g, "_")}_buyers_guide_en_es.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        void confirmPrint();
        setGenerating(false);
        return;
      }

      if (!res.ok) {
        const json = await res.json() as { error?: string };
        throw new Error(json.error ?? "Generation failed");
      }
      // Preview path: hold the token; the print is recorded (and onPrinted
      // fired) on Send/Download. A regenerate gets a fresh, unconfirmed token.
      tokenRef.current = res.headers.get("X-Print-Token");
      confirmedRef.current = false;
      const blob = await res.blob();
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const sideSuffix = side === "all" ? "" : `_${side.toUpperCase()}`;
  const filename = `${vehicleName.replace(/[^a-zA-Z0-9]+/g, "_")}_Buyers_Guide_${language.toUpperCase()}${sideSuffix}.pdf`;

  // One style for every secondary footer button (the print-action group grew
  // to four buttons in Single Sides mode).
  const secondaryBtn: React.CSSProperties = {
    height: 36, padding: "0 14px", background: "#fff", border: "1px solid var(--border)",
    borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#fff", borderRadius: 6, width: "min(960px, 96vw)", height: "min(90vh, 840px)", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "var(--text-primary)" }}>Buyer's Guide — {vehicleName}</span>
          <button onClick={onClose} style={{ fontSize: 20, color: "var(--text-muted)", lineHeight: 1, background: "none", border: "none", cursor: "pointer" }}>×</button>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>

          {/* Left: form */}
          <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--border)", overflowY: "auto", padding: "16px" }}>
            {loading ? (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>Loading defaults…</p>
            ) : (
              <>
                {/* Chooses which print buttons the footer shows. Seeded from
                    the dealer's saved default; changing it here is for this
                    guide only (the default lives in Print Settings). */}
                <div className="mb-4">
                  <label className="label">Print Mode</label>
                  <select className="input w-full" value={printMode} onChange={e => setPrintMode(e.target.value as PrintMode)}>
                    {(Object.keys(PRINT_MODE_LABELS) as PrintMode[]).map(m => (
                      <option key={m} value={m}>{PRINT_MODE_LABELS[m]}</option>
                    ))}
                  </select>
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                    {printMode === "single_sides"
                      ? "Prints one side at a time — front or back, per language."
                      : "Prints the full guide — front and back together."}
                  </p>
                </div>

                <div className="mb-4">
                  <label className="label">Language</label>
                  <select className="input w-full" value={language} onChange={e => setLanguage(e.target.value as "en" | "es")}>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                  </select>
                </div>

                <div className="mb-4">
                  <label className="label">Warranty Type *</label>
                  <select className="input w-full" value={warranty.warranty_type} onChange={e => setW("warranty_type", e.target.value as BuyersGuideDefaults["warranty_type"])}>
                    {Object.entries(WARRANTY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>

                {warranty.warranty_type === "limited" && (
                  <>
                    <div className="flex gap-2 mb-3">
                      <div className="flex-1">
                        <label className="label">Labor %</label>
                        <input className="input w-full" type="number" min={0} max={100} value={warranty.labor_pct ?? ""} onChange={e => setW("labor_pct", Number(e.target.value))} placeholder="50" />
                      </div>
                      <div className="flex-1">
                        <label className="label">Parts %</label>
                        <input className="input w-full" type="number" min={0} max={100} value={warranty.parts_pct ?? ""} onChange={e => setW("parts_pct", Number(e.target.value))} placeholder="50" />
                      </div>
                    </div>
                    <div className="mb-3">
                      <label className="label">Systems Covered</label>
                      <textarea className="input w-full" rows={2} style={{ height: "auto", resize: "vertical" }} value={warranty.systems_covered ?? ""} onChange={e => setW("systems_covered", e.target.value)} placeholder="Powertrain, Engine, Transmission" />
                    </div>
                    <div className="mb-4">
                      <label className="label">Duration</label>
                      <input className="input w-full" value={warranty.duration ?? ""} onChange={e => setW("duration", e.target.value)} placeholder="30 days or 1,000 miles" />
                    </div>
                  </>
                )}

                <div className="mb-4">
                  <label className="label mb-2" style={{ display: "block" }}>Non-Dealer Warranties</label>
                  {NON_DEALER.map(({ key, label }) => (
                    <label key={key} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6, cursor: "pointer" }}>
                      <input type="checkbox" checked={warranty.non_dealer_warranties?.includes(key) ?? false} onChange={() => toggleNdw(key)} style={{ marginTop: 2, flexShrink: 0 }} />
                      <span className="text-xs" style={{ color: "var(--text-secondary)", lineHeight: 1.4 }}>{label}</span>
                    </label>
                  ))}
                </div>

                <div className="mb-4">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={warranty.service_contract ?? false} onChange={e => setW("service_contract", e.target.checked)} />
                    <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Service contract available</span>
                  </label>
                </div>

                <div className="mb-4">
                  <label className="label">Dealer Email (optional)</label>
                  <input className="input w-full" type="email" value={warranty.dealer_email ?? ""} onChange={e => setW("dealer_email", e.target.value)} placeholder="sales@dealer.com" />
                </div>

                <div className="mb-4">
                  <label className="label">For Complaints After Sale, Contact (optional)</label>
                  <input className="input w-full" value={warranty.complaints_contact ?? ""} onChange={e => setW("complaints_contact", e.target.value)} placeholder="Jane Doe, (555) 555-1212, complaints@dealer.com" />
                  <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
                    Fills the &ldquo;FOR COMPLAINTS AFTER SALE, CONTACT:&rdquo; line on the back of both English and Spanish Buyer&apos;s Guides.
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Right: preview */}
          <div style={{ flex: 1, minWidth: 0, position: "relative", background: "#f0f0f0" }}>
            {generating && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <style>{`@keyframes bg-spin { to { transform: rotate(360deg); } }`}</style>
                <div style={{ width: 36, height: 36, border: "3px solid var(--border)", borderTop: "3px solid #1976d2", borderRadius: "50%", animation: "bg-spin 0.8s linear infinite" }} />
                <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>Generating Buyer's Guide…</p>
              </div>
            )}
            {genError && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
                <p style={{ color: "var(--error)", fontSize: 14, textAlign: "center" }}>{genError}</p>
              </div>
            )}
            {!generating && !genError && !blobUrl && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Configure options on the left, then generate.</p>
                <button className="btn btn-primary" style={{ height: 36, padding: "0 20px" }} onClick={() => void generate("single")} disabled={generating}>
                  Generate PDF
                </button>
              </div>
            )}
            {blobUrl && !generating && (
              <iframe ref={iframeRef} src={blobUrl} style={{ width: "100%", height: "100%", border: "none", display: "block" }} title="Buyer's Guide Preview" />
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-subtle)", flexWrap: "wrap" }}>
          {/* Print actions. Every button here routes through the same
              generate() → preview → "Send to Printer" flow; they differ only
              in language and which side(s) of the guide come back. */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => void generate("zip")} disabled={generating} style={secondaryBtn}>
              Generate Both (EN + ES) → ZIP
            </button>

            {printMode === "single_sides" ? (
              <>
                <button onClick={() => void generate("single", { lang: "es", side: "front" })} disabled={generating} style={secondaryBtn}>
                  Print Front ES
                </button>
                <button onClick={() => void generate("single", { lang: "es", side: "back" })} disabled={generating} style={secondaryBtn}>
                  Print Back ES
                </button>
                <button onClick={() => void generate("single", { lang: "en", side: "front" })} disabled={generating} style={secondaryBtn}>
                  Print Front EN
                </button>
                <button onClick={() => void generate("single", { lang: "en", side: "back" })} disabled={generating} style={secondaryBtn}>
                  Print Back EN
                </button>
              </>
            ) : (
              <>
                <button onClick={() => void generate("single", { lang: "es", side: "all" })} disabled={generating} style={secondaryBtn}>
                  Print Spanish
                </button>
                {/* Same generation path as the ZIP button — only the delivery
                    differs: one merged PDF into the preview, so Send to Printer
                    raises a print dialog instead of downloading two files. */}
                <button onClick={() => void generate("merged")} disabled={generating} style={secondaryBtn}>
                  Print Both
                </button>
                <button onClick={() => void generate("single", { lang: "en", side: "all" })} disabled={generating} style={secondaryBtn}>
                  Print English
                </button>
              </>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
            <button onClick={onClose} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
              Close
            </button>
            {pdfUrl && blobUrl && (
              <>
                <a href={blobUrl} download={filename} onClick={() => { void confirmPrint(); }} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, color: "var(--text-primary)", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                  Download PDF
                </a>
                <button
                  onClick={async () => {
                    if (!blobUrl) return;
                    await confirmPrint();
                    printPdfFromBlobUrl(blobUrl);
                    onClose();
                  }}
                  style={{ height: 36, padding: "0 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Send to Printer
                </button>
              </>
            )}
            <button className="btn btn-primary" onClick={() => void generate("single")} disabled={generating} style={{ height: 36, padding: "0 16px" }}>
              {blobUrl ? "Regenerate" : "Generate PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
