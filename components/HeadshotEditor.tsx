"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { Avatar } from "@/components/Avatar";

// Headshot / profile photo (migration 172). Choose an image → drag to
// reposition and zoom a SQUARE crop with a live CIRCULAR preview → save. The
// browser crops to a 400×400 square; the Steven chat shows it in a circle when
// this person takes over a chat. Server: POST/DELETE /api/users/[id]/headshot.

type Props = {
  userId: string;
  name?: string | null;
  /** Omit to load the current photo from the server. */
  currentUrl?: string | null;
  onChange?: (url: string | null) => void;
};

const OUT = 400;

async function cropToBlob(src: string, area: Area): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const canvas = document.createElement("canvas");
  canvas.width = OUT; canvas.height = OUT;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, OUT, OUT);
  ctx.drawImage(img, area.x, area.y, area.width, area.height, 0, 0, OUT, OUT);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("crop failed"))), "image/jpeg", 0.9));
}

export default function HeadshotEditor({ userId, name, currentUrl, onChange }: Props) {
  const [url, setUrl] = useState<string | null>(currentUrl ?? null);
  useEffect(() => {
    if (currentUrl !== undefined) return;
    let alive = true;
    fetch(`/api/users/${userId}/headshot`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j) setUrl(j.url ?? null); }).catch(() => {});
    return () => { alive = false; };
  }, [userId, currentUrl]);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const onComplete = useCallback((_: Area, px: Area) => setArea(px), []);

  function pick(f: File | undefined) {
    if (!f) return;
    if (!/^image\//.test(f.type)) { setErr("Choose an image file"); return; }
    setErr(null); setZoom(1); setCrop({ x: 0, y: 0 });
    const r = new FileReader(); r.onload = () => setSrc(String(r.result)); r.readAsDataURL(f);
  }

  async function save() {
    if (!src || !area) return;
    setBusy(true); setErr(null);
    try {
      const blob = await cropToBlob(src, area);
      const fd = new FormData(); fd.append("file", blob, "headshot.jpg");
      const res = await fetch(`/api/users/${userId}/headshot`, { method: "POST", body: fd });
      const j = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !j.url) { setErr(j.error ?? "Could not save the photo"); return; }
      setUrl(j.url); setSrc(null); onChange?.(j.url);
    } catch { setErr("Could not save the photo"); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setErr(null);
    const res = await fetch(`/api/users/${userId}/headshot`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) { setUrl(null); onChange?.(null); } else setErr("Could not remove the photo");
  }

  return (
    <div>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
        onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
      {src ? (
        <div>
          <div style={{ position: "relative", width: "100%", height: 260, background: "#f5f6f7", borderRadius: 6, overflow: "hidden" }}>
            <Cropper image={src} crop={crop} zoom={zoom} aspect={1} cropShape="round" showGrid={false}
              onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={onComplete} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0" }}>
            <span style={{ fontSize: 12, color: "#78828c" }}>Zoom</span>
            <input type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ flex: 1 }} aria-label="Zoom" />
          </div>
          <div style={{ fontSize: 12, color: "#78828c", marginBottom: 8 }}>Drag the photo to position it in the circle.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !area}>{busy ? "Saving…" : "Save photo"}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setSrc(null)} disabled={busy}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Avatar url={url} name={name} size={56} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary" onClick={() => fileRef.current?.click()} disabled={busy}>{url ? "Change photo" : "Upload photo"}</button>
            {url && <button type="button" className="btn btn-secondary" onClick={() => void remove()} disabled={busy}>Remove</button>}
          </div>
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: "#c62828", marginTop: 6 }}>{err}</div>}
    </div>
  );
}
