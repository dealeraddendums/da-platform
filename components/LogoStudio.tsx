"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Logo Studio (DA-LogoForge Phase 3): upload a raster logo → cleaned, vectorized
// SVG → before/after on white → save. Shared by My Group → Logo Studio
// (mode "group": saves to the group's logo library) and Print Settings → Dealer
// Logo → "Clean up / vectorize" (mode "dealer": one-click Set as Dealer Logo).
// Everything goes through /api/logo-studio/* — the browser never talks to the
// logo service itself. The scope is resolved server-side; `dealerId` is sent
// only so a mismatched session is refused rather than writing another store.

const C = { navy: "#2a2b3c", blue: "#1976d2", border: "#e0e0e0", muted: "#78828c", red: "#c62828", green: "#15803D" };
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? C.blue : "#fff", color: primary ? "#fff" : C.blue,
  border: `1px solid ${primary ? C.blue : C.border}`, borderRadius: 4, padding: "7px 14px",
  fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
});

type Props =
  | { mode: "group"; groupId: string; inTab?: boolean }
  | { mode: "dealer"; dealerId: string; onLogoSet: (url: string) => void; onClose?: () => void };

type Preview = { svg: string; replaced: string[]; franchises: string[] };
type LibLogo = { id: string | null; url: string; display_name: string; scope: string };

/** "Redmond Chevrolet!" → "redmond-chevrolet"; empty → "logo". */
function slugName(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || "logo";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Render the cleaned SVG to a PNG (long edge 1500 px, transparent). */
function svgToPngBlob(svg: string, longEdge = 1500): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
      const k = longEdge / Math.max(w, h);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * k);
      canvas.height = Math.round(h * k);
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("no canvas")); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG export failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("Couldn't render the logo"));
    img.src = svgDataUrl(svg);
  });
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

export default function LogoStudio(props: Props) {
  const qs = props.mode === "group"
    ? `scope=group&group=${encodeURIComponent(props.groupId)}`
    : `scope=dealer&dealer=${encodeURIComponent(props.dealerId)}`;
  const fileRef = useRef<HTMLInputElement>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"vectorize" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibLogo[] | null>(null);

  const groupId = props.mode === "group" ? props.groupId : null;
  const loadLibrary = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await fetch(`/api/image-library?bucket=new-dealer-logos&group=${encodeURIComponent(groupId)}`);
      const j = await res.json() as { images?: LibLogo[] };
      setLibrary((j.images ?? []).filter((i) => i.scope === "group"));
    } catch { setLibrary([]); }
  }, [groupId]);
  useEffect(() => { void loadLibrary(); }, [loadLibrary]);
  useEffect(() => () => { if (original) URL.revokeObjectURL(original); }, [original]);

  async function onFile(f: File) {
    setErr(null); setDone(null); setPreview(null);
    if (original) URL.revokeObjectURL(original);
    setOriginal(URL.createObjectURL(f));
    setName(f.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Logo");
    setBusy("vectorize");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch(`/api/logo-studio/vectorize?${qs}`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({})) as Partial<Preview> & { error?: string };
      if (!res.ok || !j.svg) { setErr(j.error ?? "Logo cleanup failed."); return; }
      setPreview({ svg: j.svg, replaced: j.replaced ?? [], franchises: j.franchises ?? [] });
    } catch { setErr("Logo cleanup failed — check your connection and try again."); }
    finally { setBusy(null); }
  }

  async function save(setAsDealerLogo: boolean) {
    if (!preview) return;
    setErr(null); setBusy("save");
    try {
      const res = await fetch(`/api/logo-studio/save?${qs}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ svg: preview.svg, name, setAsDealerLogo }),
      });
      const j = await res.json().catch(() => ({})) as { error?: string; logo_url?: string | null };
      if (!res.ok) { setErr(j.error ?? "Couldn't save the logo."); return; }
      if (props.mode === "dealer" && setAsDealerLogo && j.logo_url) {
        props.onLogoSet(j.logo_url);
        setDone("Done. Your Logo widgets now print this logo on addendums and infosheets.");
      } else {
        setDone(props.mode === "group"
          ? "Saved to the Group Logo Library. Member dealerships can pick it from the Logo widget's library or set it as their dealer logo."
          : "Saved to your logo library.");
      }
      setPreview(null);
      void loadLibrary();
    } catch { setErr("Couldn't save the logo."); }
    finally { setBusy(null); }
  }

  const reset = () => { setPreview(null); setErr(null); setDone(null); if (fileRef.current) fileRef.current.value = ""; };

  const frame = (label: string, src: string | null, alt: string) => (
    <div style={{ flex: "1 1 240px", minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ height: 180, border: `1px solid ${C.border}`, borderRadius: 4, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
        {src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt={alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          : <span style={{ fontSize: 12, color: C.muted }}>{busy === "vectorize" ? "Cleaning up your logo… this takes a few seconds" : ""}</span>}
      </div>
    </div>
  );

  const wrapStyle: React.CSSProperties = props.mode === "group"
    ? { background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "16px 24px", fontFamily: "Roboto, sans-serif" }
    : { fontFamily: "Roboto, sans-serif" };

  return (
    <div style={wrapStyle}>
      {props.mode === "group" && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: C.navy }}>Logo Studio</span>
          <span style={{ fontSize: 12, color: C.muted }}>Turn a blurry or low-res logo into a clean, sharp vector logo for your dealerships</span>
        </div>
      )}

      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />

      {!original && (
        <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 24, textAlign: "center" }}>
          <p style={{ fontSize: 13, color: C.navy, margin: "0 0 4px" }}>Upload the logo you have: a PNG, JPG or WEBP, even a small or fuzzy one.</p>
          <p style={{ fontSize: 12, color: C.muted, margin: "0 0 12px" }}>We trace it into a sharp vector (SVG) that prints crisply at any size.</p>
          <button style={btn(true)} onClick={() => fileRef.current?.click()}>Choose image…</button>
        </div>
      )}

      {original && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {frame("Before (your upload)", original, "Original logo")}
            {frame("After (cleaned vector)", preview ? svgDataUrl(preview.svg) : null, "Cleaned logo")}
          </div>
          {preview && (
            <p style={{ fontSize: 12, color: C.muted, margin: "8px 0 0" }}>
              {preview.replaced.length
                ? `Replaced with the official ${preview.replaced.join(" and ")} logo${preview.replaced.length > 1 ? "s" : ""}. `
                : ""}
              Check it closely before you save. If something looks off, try a larger or sharper image.
            </p>
          )}
          {preview && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Logo name"
                style={{ border: `1px solid ${C.border}`, borderRadius: 4, padding: "6px 10px", fontSize: 13, minWidth: 200, fontFamily: "inherit" }} />
              {props.mode === "group" ? (
                <button style={btn(true)} disabled={busy !== null} onClick={() => void save(false)}>
                  {busy === "save" ? "Saving…" : "Save to Group Logo Library"}
                </button>
              ) : (
                <>
                  <button style={btn(true)} disabled={busy !== null} onClick={() => void save(true)}>
                    {busy === "save" ? "Saving…" : "Set as Dealer Logo"}
                  </button>
                  <button style={btn()} disabled={busy !== null} onClick={() => void save(false)}>Save to my logos only</button>
                </>
              )}
              {/* Download the cleaned (already sanitized) After SVG to touch up in
                  Illustrator. Client-side only: saves nothing, sets nothing. */}
              <button style={btn()} disabled={busy !== null}
                onClick={() => downloadBlob(new Blob([preview.svg], { type: "image/svg+xml" }), `${slugName(name)}.svg`)}>
                Download SVG
              </button>
              <button style={btn()} disabled={busy !== null}
                onClick={() => { void svgToPngBlob(preview.svg).then((b) => downloadBlob(b, `${slugName(name)}.png`)).catch((e: Error) => setErr(e.message)); }}>
                Download PNG
              </button>
            </div>
          )}
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <button style={btn()} disabled={busy !== null} onClick={() => { reset(); fileRef.current?.click(); }}>Try another image</button>
            {props.mode === "dealer" && props.onClose && <button style={btn()} disabled={busy === "save"} onClick={props.onClose}>Close</button>}
          </div>
        </>
      )}

      {err && <p style={{ fontSize: 13, color: C.red, margin: "10px 0 0" }}>{err}</p>}
      {done && <p style={{ fontSize: 13, color: C.green, margin: "10px 0 0" }}>{done}</p>}

      {props.mode === "group" && library && library.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginBottom: 8 }}>Group Logo Library</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {library.map((l) => (
              <div key={l.url} style={{ width: 150 }}>
                <div style={{ height: 70, border: `1px solid ${C.border}`, borderRadius: 4, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 6 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={l.url} alt={l.display_name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.display_name}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
