"use client";

// Buyer's Guide pre-printed-label alignment — guided, photo-first flow
// (UX redesign 2026-08-26; same data model + endpoints as the original tool).
//
// A dealer prints Buyer's Guides on their OWN pre-printed FTC label stock; DA
// prints only the variable data. This tool calibrates where each field lands:
//   1. Which label do you have? (language / variant)
//   2. Take two photos of the blank label (front + back) — primary path
//   3. Auto-detect places the fields ON the photo (runs automatically)
//   4. Nudge anything that's off (drag, or arrows; per-field or all together)
//   5. Test print on real label stock → nudge → reprint → Save
// Nothing renders on the canvas until there's a photo (or the explicit
// "align without photos" fallback). Offsets stay the source of truth; photos
// live only in the browser + the one-time auto-detect call — never stored.
//
// COORDINATE-SPACE FIX (2026-08-26): a phone photo shows the label tilted
// inside a larger frame, so overlaying fields on the raw photo was not
// predictive of the print. Each uploaded photo now goes through an "Outline
// your label" sub-step (four draggable corner dots, auto-seeded) and is
// perspective-flattened so the LABEL fills the canvas edge-to-edge at the
// print aspect (612×792 = 8.5×11, the FTC guide's physical size — the label
// dimensions drive the normalization). All placement, auto-detect, and
// nudging happen in that label/print coordinate space.

import { useCallback, useEffect, useRef, useState } from "react";
import { bgFieldDefs, BG_PAGE_W, BG_PAGE_H, type BgFieldDef } from "@/lib/buyers-guide-alignment-constants";
import { flattenQuadToDataUrl, seedCorners, type Pt } from "@/lib/perspective-flatten";

const SCALE = 0.72;

type Offsets = Record<string, { x: number; y: number }>;

const stepBadge = (n: number): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 22, height: 22, borderRadius: "50%", background: "#1976d2", color: "#fff",
  fontSize: 12, fontWeight: 700, marginRight: 8, flexShrink: 0,
});
const stepTitle: React.CSSProperties = { fontSize: 13, fontWeight: 700, color: "var(--text-primary)" };
const stepHint: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", margin: "2px 0 0 30px" };

export default function BuyersGuideAlignment({ dealerId }: { dealerId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState<"en" | "es">("en");
  const [implied, setImplied] = useState(false);
  const [global, setGlobal] = useState({ x: 0, y: 0 });
  const [fields, setFields] = useState<Offsets>({});
  const [page, setPage] = useState<0 | 1>(0);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [moveAll, setMoveAll] = useState(false);
  // Flattened (deskewed, label-filling) images per side — the ONLY backdrop.
  const [flat, setFlat] = useState<{ front: string | null; back: string | null }>({ front: null, back: null });
  // Active "outline your label" session for a freshly-uploaded photo.
  const [outline, setOutline] = useState<{ side: "front" | "back"; img: HTMLImageElement; url: string; corners: [Pt, Pt, Pt, Pt] } | null>(null);
  const [manualNoPhoto, setManualNoPhoto] = useState(false);
  const [detectState, setDetectState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
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
    if (!moveAll && selKey) {
      setFields((f) => ({ ...f, [selKey]: { x: (f[selKey]?.x ?? 0) + dx, y: (f[selKey]?.y ?? 0) + dy } }));
    } else {
      setGlobal((g) => ({ x: g.x + dx, y: g.y + dy }));
    }
  }

  function startDrag(e: React.MouseEvent, d: BgFieldDef) {
    e.preventDefault();
    setSelKey(d.key);
    setMoveAll(false);
    const sx = e.clientX, sy = e.clientY;
    const start = fields[d.key] ?? { x: 0, y: 0 };
    const move = (ev: MouseEvent) => {
      setFields((f) => ({
        ...f,
        [d.key]: {
          x: Math.round(start.x + (ev.clientX - sx) / SCALE),
          y: Math.round(start.y - (ev.clientY - sy) / SCALE),
        },
      }));
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  async function onPhotoChosen(side: "front" | "back", file: File | null) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setPage(side === "front" ? 0 : 1);
      setOutline({ side, img, url, corners: seedCorners(img) });
      setMsg(null);
    };
    img.onerror = () => setMsg("Couldn't read that image — try a different photo.");
    img.src = url;
  }

  function confirmOutline() {
    if (!outline) return;
    let dataUrl: string;
    try {
      // 2× print resolution: keeps the form text legible for the vision call
      // (the backdrop scales down; detect coordinates are normalized anyway).
      dataUrl = flattenQuadToDataUrl(outline.img, outline.corners, BG_PAGE_W * 2, BG_PAGE_H * 2);
    } catch {
      setMsg("Couldn't straighten the photo — try again or align manually.");
      setOutline(null);
      return;
    }
    const side = outline.side;
    setFlat((f) => {
      const next = { ...f, [side]: dataUrl };
      // Auto-detect runs on the FLATTENED form images (label space) whenever
      // the front exists — a late-added back re-runs with both sides.
      if (next.front) void autoDetect(next.front, next.back);
      return next;
    });
    setOutline(null);
  }

  async function autoDetect(frontFlat?: string | null, backFlat?: string | null) {
    const front = frontFlat ?? flat.front;
    const back = backFlat ?? flat.back;
    if (!front) { setMsg("Add and outline the FRONT photo first."); return; }
    setDetectState("running"); setMsg(null);
    try {
      const body = {
        front,
        back: back ?? undefined,
        language, implied,
      };
      const res = await fetch(`/api/settings/buyers-guide-alignment/detect?dealer_id=${encodeURIComponent(dealerId)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = await res.json() as { ok?: boolean; global?: { x: number; y: number }; fields?: Offsets; detected_count?: number; error?: string };
      if (!res.ok || !j.ok) {
        setDetectState("failed");
        setMsg(j.error ?? "We couldn't place the fields automatically — drag them into position on your photo instead.");
        return;
      }
      setGlobal(j.global ?? { x: 0, y: 0 });
      setFields(j.fields ?? {});
      setDetectState("done");
      setMsg("Fields placed! Check them against your photo below — drag or nudge anything that's off, then run a test print.");
    } catch {
      setDetectState("failed");
      setMsg("We couldn't place the fields automatically — drag them into position on your photo instead.");
    }
  }

  async function testPrint() {
    setBusy("print"); setMsg(null);
    try {
      const res = await fetch("/api/settings/buyers-guide-alignment/test-print", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealer_id: dealerId, language, global, fields }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null) as { error?: string } | null; setMsg(j?.error ?? "Test print failed — try again."); return; }
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
      setMsg("Test page opened — print it on a BLANK label, hold it up to the light against a printed one, and nudge anything that's off. Repeat until it lines up, then Save.");
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
      if (!res.ok || !j?.ok) { setMsg(j?.error ?? "Save failed — try again."); return; }
      setEnabled(nextEnabled);
      setMsg(nextEnabled
        ? "Saved! Buyer's Guides for this dealership now print just the data, positioned for your labels."
        : "Saved — label mode is off; Buyer's Guides print the full form again.");
    } finally { setBusy(null); }
  }

  if (!loaded) return <div className="p-4 text-sm" style={{ color: "var(--text-muted)" }}>Loading…</div>;

  const bd = page === 0 ? flat.front : flat.back;
  const showChips = Boolean(bd) || manualNoPhoto;
  const pageDefs = defs.filter((d) => d.page === page);
  const selDef = selKey ? defs.find((d) => d.key === selKey) : null;

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Master switch */}
      <label className="flex items-center gap-2 cursor-pointer mb-4" style={{ userSelect: "none" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => void save(e.target.checked)} disabled={busy !== null} />
        <span className="text-sm font-semibold">This dealership prints Buyer&apos;s Guides on its own pre-printed labels</span>
      </label>
      {!enabled && (
        <p className="text-xs mb-4" style={{ color: "var(--text-muted)", marginLeft: 24 }}>
          Turn this on when your labels already have the Buyers Guide form printed on them — DA will print just the vehicle and warranty info, positioned to land in your form&apos;s boxes. Set up the alignment below first if you like; it only takes effect once this is on.
        </p>
      )}

      {/* Step 1 */}
      <div className="mb-4">
        <div className="flex items-center flex-wrap gap-2">
          <span style={stepBadge(1)}>1</span>
          <span style={stepTitle}>Which label do you have?</span>
          <select className="input" style={{ width: 110, height: 28, fontSize: 12 }} value={language} onChange={(e) => setLanguage(e.target.value as "en" | "es")}>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
          <select className="input" style={{ width: 210, height: 28, fontSize: 12 }} value={implied ? "implied" : "asis"} onChange={(e) => setImplied(e.target.value === "implied")}>
            <option value="asis">Standard (&ldquo;AS IS&rdquo;) version</option>
            <option value="implied">&ldquo;Implied Warranties Only&rdquo; version</option>
          </select>
        </div>
      </div>

      {/* Step 2 */}
      <div className="mb-4">
        <div className="flex items-center flex-wrap gap-2">
          <span style={stepBadge(2)}>2</span>
          <span style={stepTitle}>Take two photos of a BLANK label — front and back</span>
        </div>
        <p style={stepHint}>Any angle is fine — you&apos;ll mark the label&apos;s four corners next, and we&apos;ll straighten the photo and place the fields for you.</p>
        <div className="flex items-center gap-3 flex-wrap" style={{ margin: "8px 0 0 30px" }}>
          <label className="btn btn-secondary" style={{ height: 34, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
            📷 {flat.front ? "Front photo ✓ (replace)" : "Add FRONT photo"}
            <input ref={frontFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => void onPhotoChosen("front", e.target.files?.[0] ?? null)} />
          </label>
          <label className="btn btn-secondary" style={{ height: 34, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center" }}>
            📷 {flat.back ? "Back photo ✓ (replace)" : "Add BACK photo"}
            <input ref={backFileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => void onPhotoChosen("back", e.target.files?.[0] ?? null)} />
          </label>
          {detectState === "running" && <span className="text-xs font-medium" style={{ color: "var(--blue)" }}>✨ Placing the fields on your photo…</span>}
          {detectState === "done" && <span className="text-xs font-medium" style={{ color: "#2e7d32" }}>✓ Fields placed automatically</span>}
          {detectState === "failed" && flat.front && (
            <button className="text-xs" style={{ color: "var(--blue)", background: "none", border: "none", cursor: "pointer" }} onClick={() => void autoDetect()}>try auto-place again</button>
          )}
        </div>
        {!showChips && (
          <button className="text-xs mt-2" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", marginLeft: 30, textDecoration: "underline" }}
            onClick={() => setManualNoPhoto(true)}>
            No photo handy? Align on a blank page instead
          </button>
        )}
      </div>

      {/* Outline-your-label sub-step: four draggable corner dots over the raw
          photo → perspective-flatten so the label fills the canvas in print
          coordinates. Shown only while a fresh photo awaits outlining. */}
      {outline && (() => {
        const maxW = 460;
        const scale = Math.min(maxW / outline.img.naturalWidth, 560 / outline.img.naturalHeight);
        const w = outline.img.naturalWidth * scale;
        const h = outline.img.naturalHeight * scale;
        const poly = outline.corners.map((c) => `${c.x * scale},${c.y * scale}`).join(" ");
        const startCorner = (e: React.MouseEvent, i: number) => {
          e.preventDefault();
          const sx = e.clientX, sy = e.clientY;
          const start = outline.corners[i];
          const move = (ev: MouseEvent) => {
            setOutline((o) => {
              if (!o) return o;
              const corners = [...o.corners] as [Pt, Pt, Pt, Pt];
              corners[i] = {
                x: Math.min(Math.max(start.x + (ev.clientX - sx) / scale, 0), o.img.naturalWidth),
                y: Math.min(Math.max(start.y + (ev.clientY - sy) / scale, 0), o.img.naturalHeight),
              };
              return { ...o, corners };
            });
          };
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        };
        return (
          <div className="mb-4" style={{ marginLeft: 30 }}>
            <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-primary)" }}>
              Outline your label ({outline.side}) — drag the dots to its four corners
            </p>
            <div style={{ position: "relative", width: w, height: h, borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={outline.url} alt="your label photo" style={{ width: w, height: h, display: "block", userSelect: "none" }} draggable={false} />
              <svg style={{ position: "absolute", inset: 0, pointerEvents: "none" }} width={w} height={h}>
                <polygon points={poly} fill="rgba(25,118,210,0.12)" stroke="#1976d2" strokeWidth={2} />
              </svg>
              {outline.corners.map((c, i) => (
                <div key={i}
                  onMouseDown={(e) => startCorner(e, i)}
                  style={{
                    position: "absolute", left: c.x * scale - 11, top: c.y * scale - 11,
                    width: 22, height: 22, borderRadius: "50%", cursor: "grab",
                    background: "#1976d2", border: "3px solid #fff", boxShadow: "0 1px 4px rgba(0,0,0,.4)",
                  }} />
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button className="btn btn-primary" style={{ height: 32 }} onClick={confirmOutline}>
                ✓ Corners look right — straighten it
              </button>
              <button className="text-xs" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
                onClick={() => setOutline(null)}>
                cancel this photo
              </button>
            </div>
          </div>
        );
      })()}

      {/* Step 3 + canvas */}
      <div className="mb-2">
        <div className="flex items-center flex-wrap gap-2">
          <span style={stepBadge(3)}>3</span>
          <span style={stepTitle}>Check the placement on your straightened label</span>
          <div className="flex" style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", marginLeft: 6 }}>
            {([0, 1] as const).map((pg) => (
              <button key={pg} onClick={() => { setPage(pg); setSelKey(null); }}
                className="text-xs font-semibold px-3 py-1"
                style={{ background: page === pg ? "#1976d2" : "transparent", color: page === pg ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>
                {pg === 0 ? "Front" : "Back"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{
        position: "relative", width: BG_PAGE_W * SCALE, height: BG_PAGE_H * SCALE,
        background: "#fff", border: "1px solid var(--border)", borderRadius: 4, overflow: "hidden",
        backgroundImage: bd ? `url(${bd})` : undefined, backgroundSize: "100% 100%",
      }}>
        {!showChips && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#9aa3ac", fontSize: 14, textAlign: "center", padding: 32, gap: 8 }}>
            <div style={{ fontSize: 34 }}>📷</div>
            <div style={{ fontWeight: 600 }}>Upload a photo of your blank label to begin</div>
            <div style={{ fontSize: 12 }}>We&apos;ll place the print fields right on your photo so you can see they line up.</div>
          </div>
        )}
        {showChips && pageDefs.map((d) => {
          const p = fieldPos(d);
          const left = p.x * SCALE;
          const top = (BG_PAGE_H - p.y) * SCALE;
          const sel = selKey === d.key;
          return (
            <div key={d.key}
              onMouseDown={(e) => startDrag(e, d)}
              title={`${d.label} — drag it onto the matching spot on your label`}
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

      {/* Step 4 */}
      {showChips && (
        <div className="mt-3 mb-4">
          <div className="flex items-center flex-wrap gap-2">
            <span style={stepBadge(4)}>4</span>
            <span style={stepTitle}>Nudge anything that&apos;s off</span>
          </div>
          <p style={stepHint}>Drag a field with your mouse, or click one and use the arrows for small moves.</p>
          <div className="flex items-center gap-2 flex-wrap" style={{ margin: "8px 0 0 30px" }}>
            <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>Move:</span>
            <div className="flex" style={{ border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
              <button onClick={() => setMoveAll(false)} disabled={!selDef}
                className="text-xs font-semibold px-3 py-1"
                style={{ background: !moveAll && selDef ? "#1976d2" : "transparent", color: !moveAll && selDef ? "#fff" : selDef ? "var(--text-secondary)" : "#c4cbd2", border: "none", cursor: selDef ? "pointer" : "not-allowed" }}>
                {selDef ? `just “${selDef.label}”` : "just this field (click one)"}
              </button>
              <button onClick={() => setMoveAll(true)}
                className="text-xs font-semibold px-3 py-1"
                style={{ background: moveAll || !selDef ? "#1976d2" : "transparent", color: moveAll || !selDef ? "#fff" : "var(--text-secondary)", border: "none", cursor: "pointer" }}>
                all fields together
              </button>
            </div>
            <div className="flex items-center gap-1">
              {([["←", -1, 0], ["→", 1, 0], ["↑", 0, 1], ["↓", 0, -1]] as const).map(([sym, dx, dy]) => (
                <button key={sym} onClick={() => nudge(dx, dy)} title="Small move"
                  style={{ width: 28, height: 28, border: "1px solid var(--border)", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 13 }}>
                  {sym}
                </button>
              ))}
            </div>
            <button className="text-xs" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
              disabled={busy !== null}
              onClick={() => { if (confirm("Start over? This puts every field back at its standard position.")) { setGlobal({ x: 0, y: 0 }); setFields({}); setSelKey(null); setDetectState("idle"); } }}>
              Start over
            </button>
            <span className="text-xs" style={{ color: "#c4cbd2", fontFamily: "monospace" }} title="Fine position readout (printer points)">
              {moveAll || !selDef ? `all ${global.x >= 0 ? "+" : ""}${global.x}, ${global.y >= 0 ? "+" : ""}${global.y}` : `${(fields[selDef.key]?.x ?? 0) >= 0 ? "+" : ""}${fields[selDef.key]?.x ?? 0}, ${(fields[selDef.key]?.y ?? 0) >= 0 ? "+" : ""}${fields[selDef.key]?.y ?? 0}`}
            </span>
          </div>
        </div>
      )}

      {/* Step 5 */}
      <div className="mt-3">
        <div className="flex items-center flex-wrap gap-2">
          <span style={stepBadge(5)}>5</span>
          <span style={stepTitle}>Test print &amp; save</span>
        </div>
        <p style={stepHint}>Print the test page on a blank label. If anything misses its box, nudge it (step 4) and print again — then save.</p>
        <div className="flex items-center gap-2 flex-wrap" style={{ margin: "8px 0 0 30px" }}>
          <button className="btn btn-primary" style={{ height: 32 }} disabled={busy !== null} onClick={() => void testPrint()}>
            {busy === "print" ? "Preparing…" : "🖨 Print a test on your label"}
          </button>
          <button className="btn btn-primary" style={{ height: 32, background: "#2e7d32" }} disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save alignment"}
          </button>
          <button className="text-xs" style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
            disabled={busy !== null}
            title="On-screen sanity check: the standard DA Buyers Guide form with your data (no offsets applied)"
            onClick={() => void (async () => {
              setBusy("print");
              try {
                const res = await fetch("/api/settings/buyers-guide-alignment/test-print", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ dealer_id: dealerId, language, withBackground: true }),
                });
                if (res.ok) window.open(URL.createObjectURL(await res.blob()), "_blank");
              } finally { setBusy(null); }
            })()}>
            see it on DA&apos;s standard form
          </button>
        </div>
      </div>

      {msg && <p className="text-xs mt-3 font-medium" style={{ color: "var(--blue)", maxWidth: 640 }}>{msg}</p>}
      <p className="text-xs mt-2" style={{ color: "var(--text-muted)", maxWidth: 640 }}>
        Your photos stay in your browser and are used only to place the fields — they&apos;re never stored. Every required Buyers Guide field always prints; this tool only positions them on your label.
      </p>
    </div>
  );
}
