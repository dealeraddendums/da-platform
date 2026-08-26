"use client";

// Buyer's Guide pre-printed-label alignment tool (migration 150).
//
// For dealers printing Buyer's Guides on their OWN pre-printed FTC label
// stock: DA renders DATA-ONLY output, and this tool calibrates where each
// standard field lands. Offsets start from the calibrated default positions;
// the operator can (1) drag/nudge fields manually — optionally over an
// uploaded photo/scan of the blank label as a faint backdrop — or (2) snap
// front/back photos and let AI vision pre-fill approximate positions, then
// fine-tune. The "Test print" outputs the data-only PDF with the CURRENT
// (unsaved) offsets for iterative calibration on real label stock.
//
// This is a per-DEALER print setting (their physical label), independent of
// templates — group-controlled-templates dealers still manage their own.

import { useCallback, useEffect, useRef, useState } from "react";
import { bgFieldDefs, BG_PAGE_W, BG_PAGE_H, type BgFieldDef } from "@/lib/buyers-guide-alignment-constants";

const SCALE = 0.72;

type Offsets = Record<string, { x: number; y: number }>;

export default function BuyersGuideAlignment({ dealerId }: { dealerId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState<"en" | "es">("en");
  const [implied, setImplied] = useState(false);
  const [global, setGlobal] = useState({ x: 0, y: 0 });
  const [fields, setFields] = useState<Offsets>({});
  const [page, setPage] = useState<0 | 1>(0);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [backdrop, setBackdrop] = useState<{ front: string | null; back: string | null }>({ front: null, back: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const frontFileRef = useRef<HTMLInputElement>(null);
  const backFileRef = useRef<HTMLInputElement>(null);

  const defs = bgFieldDefs(language, implied);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/settings/buyers-guide-alignment?dealer_id=${encodeURIComponent(dealerId)}`);
        const j = await res.json() as { config?: { enabled?: boolean; global?: { x: number; y: number }; fields?: Offsets; language?: string } | null };
        if (j.config) {
          setEnabled(j.config.enabled === true);
          setGlobal({ x: j.config.global?.x ?? 0, y: j.config.global?.y ?? 0 });
          setFields(j.config.fields ?? {});
          if (j.config.language === "es") setLanguage("es");
        }
      } catch { /* fresh config */ }
      setLoaded(true);
    })();
  }, [dealerId]);

  const fieldPos = useCallback((d: BgFieldDef) => ({
    x: d.x + global.x + (fields[d.key]?.x ?? 0),
    y: d.y + global.y + (fields[d.key]?.y ?? 0),
  }), [global, fields]);

  function nudge(dx: number, dy: number) {
    if (selKey) {
      setFields((f) => ({ ...f, [selKey]: { x: (f[selKey]?.x ?? 0) + dx, y: (f[selKey]?.y ?? 0) + dy } }));
    } else {
      setGlobal((g) => ({ x: g.x + dx, y: g.y + dy }));
    }
  }

  function startDrag(e: React.MouseEvent, d: BgFieldDef) {
    e.preventDefault();
    setSelKey(d.key);
    const sx = e.clientX, sy = e.clientY;
    const start = fields[d.key] ?? { x: 0, y: 0 };
    const move = (ev: MouseEvent) => {
      setFields((f) => ({
        ...f,
        [d.key]: {
          x: Math.round(start.x + (ev.clientX - sx) / SCALE),
          y: Math.round(start.y - (ev.clientY - sy) / SCALE), // screen-down = PDF-down (y flip)
        },
      }));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onBackdropFile(side: "front" | "back", file: File | null) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setBackdrop((b) => ({ ...b, [side]: url }));
  }

  async function autoDetect() {
    const toDataUrl = (f: File) => new Promise<string>((resolve, reject) => {
      const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(f);
    });
    const frontFile = frontFileRef.current?.files?.[0];
    if (!frontFile) { setMsg("Choose at least the FRONT photo first (the file inputs below)."); return; }
    const backFile = backFileRef.current?.files?.[0];
    setBusy("detect"); setMsg(null);
    try {
      const body = {
        front: await toDataUrl(frontFile),
        back: backFile ? await toDataUrl(backFile) : undefined,
        language, implied,
      };
      const res = await fetch(`/api/settings/buyers-guide-alignment/detect?dealer_id=${encodeURIComponent(dealerId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json() as { ok?: boolean; global?: { x: number; y: number }; fields?: Offsets; detected_count?: number; total_fields?: number; error?: string };
      if (!res.ok || !j.ok) { setMsg(j.error ?? "Auto-detect failed — align manually."); return; }
      setGlobal(j.global ?? { x: 0, y: 0 });
      setFields(j.fields ?? {});
      setMsg(`Auto-detect placed ${j.detected_count}/${j.total_fields} fields (approximate) — review the chips over your photo, nudge what's off, then Test print.`);
      onBackdropFile("front", frontFile);
      if (backFile) onBackdropFile("back", backFile);
    } finally { setBusy(null); }
  }

  async function testPrint(withBackground: boolean) {
    setBusy("print"); setMsg(null);
    try {
      const res = await fetch("/api/settings/buyers-guide-alignment/test-print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId, language, global, fields, withBackground }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null) as { error?: string } | null; setMsg(j?.error ?? "Test print failed"); return; }
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } finally { setBusy(null); }
  }

  async function save(nextEnabled = enabled) {
    setBusy("save"); setMsg(null);
    try {
      const res = await fetch(`/api/settings/buyers-guide-alignment?dealer_id=${encodeURIComponent(dealerId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled, global, fields, language }),
      });
      const j = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !j?.ok) { setMsg(j?.error ?? "Save failed"); return; }
      setEnabled(nextEnabled);
      setMsg(nextEnabled
        ? "Saved — this dealer's Buyer's Guides now print DATA-ONLY at these positions (single + bulk)."
        : "Saved — pre-printed mode is OFF; full-background Buyer's Guides.");
    } finally { setBusy(null); }
  }

  if (!loaded) return <div className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>Loading alignment…</div>;

  const pageDefs = defs.filter((d) => d.page === page);
  const bd = page === 0 ? backdrop.front : backdrop.back;

  return (
    <div>
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <label className="flex items-center gap-2 cursor-pointer" style={{ userSelect: "none" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => void save(e.target.checked)} disabled={busy !== null} />
          <span className="text-sm font-semibold">Print Buyer&apos;s Guides on pre-printed labels (data-only)</span>
        </label>
        <select className="input" style={{ width: 120, height: 30, fontSize: 12 }} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "es")}>
          <option value="en">English</option>
          <option value="es">Spanish</option>
        </select>
        <label className="flex items-center gap-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          <input type="checkbox" checked={implied} onChange={(e) => setImplied(e.target.checked)} /> Implied-only variant
        </label>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="flex" style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {([0, 1] as const).map((pg) => (
            <button key={pg} onClick={() => { setPage(pg); setSelKey(null); }}
              className="text-xs font-semibold px-3 py-1.5"
              style={{ background: page === pg ? "#1976d2" : "transparent", color: page === pg ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>
              {pg === 0 ? "Front" : "Back"}
            </button>
          ))}
        </div>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {selKey ? `Nudging: ${defs.find((d) => d.key === selKey)?.label ?? selKey}` : "Nudging: GLOBAL (all fields)"}
        </span>
        {selKey && <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }} onClick={() => setSelKey(null)}>switch to global</button>}
        <div className="flex items-center gap-1">
          {([["←", -1, 0], ["→", 1, 0], ["↑", 0, 1], ["↓", 0, -1]] as const).map(([sym, dx, dy]) => (
            <button key={sym} onClick={() => nudge(dx, dy)} title={`Nudge 1pt ${sym}`}
              style={{ width: 26, height: 26, border: "1px solid var(--border)", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 12 }}>
              {sym}
            </button>
          ))}
        </div>
        <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
          global {global.x >= 0 ? "+" : ""}{global.x}, {global.y >= 0 ? "+" : ""}{global.y}pt
        </span>
        <button className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy !== null} onClick={() => { setGlobal({ x: 0, y: 0 }); setFields({}); setSelKey(null); }}>
          Reset offsets
        </button>
      </div>

      {/* Canvas */}
      <div ref={canvasRef} style={{
        position: "relative", width: BG_PAGE_W * SCALE, height: BG_PAGE_H * SCALE,
        background: "#fff", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden",
        backgroundImage: bd ? `url(${bd})` : undefined, backgroundSize: "100% 100%",
      }}>
        {!bd && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#d0d5da", fontSize: 13, textAlign: "center", padding: 24, pointerEvents: "none" }}>
            Upload a photo/scan of your BLANK pre-printed label below to align against it — or drag the field chips to match your label.
          </div>
        )}
        {pageDefs.map((d) => {
          const p = fieldPos(d);
          const left = p.x * SCALE;
          const top = (BG_PAGE_H - p.y) * SCALE;
          const sel = selKey === d.key;
          return (
            <div key={d.key}
              onMouseDown={(e) => startDrag(e, d)}
              title={`${d.label} — drag to reposition (offset ${fields[d.key]?.x ?? 0}, ${fields[d.key]?.y ?? 0})`}
              style={{
                position: "absolute", left, top: top - 9, transform: d.kind === "checkbox" ? "translate(-50%, 0)" : undefined,
                padding: "1px 5px", fontSize: 9, fontWeight: 700, whiteSpace: "nowrap", cursor: "move", userSelect: "none",
                background: sel ? "#1976d2" : d.kind === "checkbox" ? "rgba(255,165,0,0.85)" : "rgba(25,118,210,0.75)",
                color: "#fff", borderRadius: 3, border: sel ? "1.5px solid #0d47a1" : "1px solid rgba(0,0,0,0.15)", zIndex: sel ? 20 : 10,
              }}>
              {d.kind === "checkbox" ? "✕ " : ""}{d.label}
            </div>
          );
        })}
      </div>

      {/* Backdrop uploads + auto-detect + test print */}
      <div className="flex items-center gap-3 flex-wrap mt-3">
        <label className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Front photo/scan: <input ref={frontFileRef} type="file" accept="image/*" onChange={(e) => onBackdropFile("front", e.target.files?.[0] ?? null)} />
        </label>
        <label className="text-xs" style={{ color: "var(--text-secondary)" }}>
          Back: <input ref={backFileRef} type="file" accept="image/*" onChange={(e) => onBackdropFile("back", e.target.files?.[0] ?? null)} />
        </label>
        <button className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} disabled={busy !== null} onClick={() => void autoDetect()}>
          {busy === "detect" ? "Detecting…" : "✨ Auto-detect from photos"}
        </button>
      </div>
      <div className="flex items-center gap-2 flex-wrap mt-3">
        <button className="btn btn-primary" style={{ height: 32 }} disabled={busy !== null} onClick={() => void testPrint(false)}>
          {busy === "print" ? "Rendering…" : "🖨 Test print (data-only)"}
        </button>
        <button className="btn btn-secondary" style={{ height: 32 }} disabled={busy !== null} onClick={() => void testPrint(true)}>
          Preview on DA form
        </button>
        <button className="btn btn-primary" style={{ height: 32, background: "#2e7d32" }} disabled={busy !== null} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : "Save alignment"}
        </button>
      </div>
      <p className="text-xs mt-2" style={{ color: "var(--text-muted)", maxWidth: 640 }}>
        Calibration loop: print the data-only test page onto a blank label, see what&apos;s off, nudge (drag a chip, or arrows for the selected field / global registration), reprint. Photos are used only in your browser and for the one-time auto-detect — they aren&apos;t stored. All required FTC fields stay present; this tool only repositions them.
      </p>
      {msg && <p className="text-xs mt-2 font-medium" style={{ color: "var(--blue)" }}>{msg}</p>}
    </div>
  );
}
