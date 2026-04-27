"use client";

import { useEffect, useRef, useState } from "react";
import type { BuyersGuideDefaults } from "@/lib/db";

type Props = {
  dealerVehicleId: string;
  vehicleName: string;
  onClose: () => void;
};

const WARRANTY_LABELS: Record<string, string> = {
  as_is: "As Is — No Dealer Warranty",
  implied_only: "Implied Warranties Only",
  full: "Full Warranty",
  limited: "Limited Warranty",
};

const NON_DEALER = [
  { key: "mfr_new", label: "Manufacturer's new vehicle warranty still applies" },
  { key: "mfr_used", label: "Manufacturer's used vehicle warranty applies" },
  { key: "other_used", label: "Other used vehicle warranty applies" },
];

export default function BuyersGuideModal({ dealerVehicleId, vehicleName, onClose }: Props) {
  const [loading, setLoading] = useState(true);
  const [warranty, setWarranty] = useState<BuyersGuideDefaults>({ warranty_type: "as_is" });
  const [language, setLanguage] = useState<"en" | "es">("en");
  const [generating, setGenerating] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then(r => r.json() as Promise<{ data?: { buyers_guide_defaults?: BuyersGuideDefaults | null } }>)
      .then(j => {
        if (j.data?.buyers_guide_defaults) setWarranty({ ...j.data.buyers_guide_defaults });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!pdfUrl) return;
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

  async function generate(both = false) {
    setGenerating(true);
    setGenError(null);
    setPdfUrl(null);
    setBlobUrl(null);
    try {
      const body = { vehicleId: dealerVehicleId, language, both, warranty };
      const res = await fetch("/api/pdf/buyers-guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (both) {
        if (!res.ok) throw new Error("Generation failed");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${vehicleName.replace(/[^a-zA-Z0-9]+/g, "_")}_buyers_guide_en_es.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setGenerating(false);
        return;
      }

      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Generation failed");
      setPdfUrl(json.url!);
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const filename = `${vehicleName.replace(/[^a-zA-Z0-9]+/g, "_")}_Buyers_Guide_${language.toUpperCase()}.pdf`;

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
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
                <button className="btn btn-primary" style={{ height: 36, padding: "0 20px" }} onClick={() => void generate(false)} disabled={generating}>
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-subtle)" }}>
          <button onClick={() => void generate(true)} disabled={generating} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
            Generate Both (EN + ES) → ZIP
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "var(--text-secondary)" }}>
              Close
            </button>
            {pdfUrl && blobUrl && (
              <>
                <a href={pdfUrl} download={filename} style={{ height: 36, padding: "0 16px", background: "#fff", border: "1px solid var(--border)", borderRadius: 4, fontSize: 13, color: "var(--text-primary)", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
                  Download PDF
                </a>
                <button onClick={() => { const w = window.open(blobUrl!, '_blank'); if (w) { let redirected = false; const doRedirect = () => { if (redirected) return; redirected = true; try { w.close(); } catch { /* ignore */ } onClose(); window.location.href = '/dashboard'; }; setTimeout(() => { w.print(); w.addEventListener('afterprint', doRedirect); setTimeout(doRedirect, 5000); }, 500); } }}
                  style={{ height: 36, padding: "0 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                  Send to Printer
                </button>
              </>
            )}
            <button className="btn btn-primary" onClick={() => void generate(false)} disabled={generating} style={{ height: 36, padding: "0 16px" }}>
              {blobUrl ? "Regenerate" : "Generate PDF"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
