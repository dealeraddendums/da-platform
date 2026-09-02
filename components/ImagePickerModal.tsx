"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface ImageEntry {
  id: string | null;
  key: string;
  url: string;
  size: number;
  display_name?: string;
  scope: "platform" | "group" | "dealer";
  deletable: boolean;
}

interface Caller {
  canUploadPlatform: boolean;
  canUploadGroup: boolean;
  canUploadDealer: boolean;
}

interface ImagePickerModalProps {
  bucket: string;
  title?: string;
  onSelect: (url: string) => void;
  onClose: () => void;
}

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export default function ImagePickerModal({ bucket, title, onSelect, onClose }: ImagePickerModalProps) {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [caller, setCaller] = useState<Caller>({ canUploadPlatform: false, canUploadGroup: false, canUploadDealer: false });
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/image-library?bucket=${encodeURIComponent(bucket)}`)
      .then((r) => r.json())
      .then((d) => {
        setImages(d.images ?? []);
        setGroupName(d.groupName ?? null);
        if (d.caller) setCaller(d.caller);
      })
      .catch(() => setImages([]))
      .finally(() => setLoading(false));
  }, [bucket]);

  useEffect(() => { load(); }, [load]);

  // Which scope does this caller's upload land in? (dealer wins if acting as one.)
  const uploadScope: "platform" | "group" | "dealer" | null =
    caller.canUploadDealer ? "dealer" : caller.canUploadGroup ? "group" : caller.canUploadPlatform ? "platform" : null;
  const uploadLabel =
    uploadScope === "dealer" ? "Upload to My Images" :
    uploadScope === "group" ? `Upload to ${groupName ?? "Group"} Library` :
    uploadScope === "platform" ? "Upload to Platform" : null;

  const doUpload = useCallback(async (file: File) => {
    setError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bucket", bucket);
      const res = await fetch("/api/image-library/upload", { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201) load();
      else setError(json.error ?? `Upload failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [bucket, load]);

  const doDelete = useCallback(async (img: ImageEntry) => {
    if (!img.id) return;
    if (!confirm(`Delete "${img.display_name ?? "this image"}"? This cannot be undone.`)) return;
    setError("");
    try {
      const res = await fetch(`/api/image-library?id=${encodeURIComponent(img.id)}`, { method: "DELETE" });
      if (res.ok) setImages((prev) => prev.filter((i) => i.id !== img.id));
      else { const j = await res.json().catch(() => ({})); setError(j.error ?? "Delete failed"); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }, []);

  const term = search.toLowerCase();
  const match = (img: ImageEntry) => (img.display_name ?? img.key.split("/").pop() ?? img.key).toLowerCase().includes(term);

  const sections: { label: string; items: ImageEntry[] }[] = [
    { label: "Platform", items: images.filter((i) => i.scope === "platform" && match(i)) },
    { label: `${groupName ?? "Group"} Library`, items: images.filter((i) => i.scope === "group" && match(i)) },
    { label: "My Images", items: images.filter((i) => i.scope === "dealer" && match(i)) },
  ].filter((s) => s.items.length > 0);

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#fff", borderRadius: 8, width: 700, maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,.22)" }}>
        {/* Header */}
        <div style={{ padding: "14px 20px", borderBottom: "1px solid #e0e0e0", background: "#2a2b3c", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>{title ?? "Choose Image"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,.7)", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>✕</button>
        </div>

        {/* Toolbar: search + upload */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #e0e0e0", display: "flex", gap: 10, alignItems: "center" }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search images…"
            style={{ flex: 1, padding: "6px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" }}
          />
          {uploadScope && (
            <>
              <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: "none" }}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f); }} />
              <button onClick={() => fileRef.current?.click()} disabled={uploading}
                style={{ whiteSpace: "nowrap", padding: "6px 12px", background: uploading ? "#9aa4ad" : "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 12, cursor: uploading ? "default" : "pointer" }}>
                {uploading ? "Uploading…" : uploadLabel}
              </button>
            </>
          )}
        </div>

        {error && (
          <div style={{ padding: "8px 16px", background: "#fdecea", color: "#c62828", fontSize: 12, borderBottom: "1px solid #f5c6cb" }}>{error}</div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading ? (
            <div style={{ textAlign: "center", padding: 48, color: "#78828c", fontSize: 13 }}>Loading…</div>
          ) : sections.length === 0 ? (
            <div style={{ textAlign: "center", padding: 48, color: "#78828c", fontSize: 13 }}>No images found</div>
          ) : (
            sections.map((section) => (
              <div key={section.label} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 10 }}>
                  {section.label}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                  {section.items.map((img) => {
                    const label = img.display_name ?? img.key.split("/").pop() ?? img.key;
                    return (
                      <div key={img.id ?? img.key} title={label}
                        style={{ position: "relative", cursor: "pointer", border: "2px solid #e0e0e0", borderRadius: 6, overflow: "hidden", background: "#fff", transition: "border-color .15s" }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#1976d2"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#e0e0e0"; }}
                        onClick={() => onSelect(img.url)}
                      >
                        {img.deletable && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void doDelete(img); }}
                            title="Delete image"
                            style={{ position: "absolute", top: 4, right: 4, zIndex: 2, width: 22, height: 22, borderRadius: "50%", border: "none", background: "rgba(0,0,0,.55)", color: "#fff", cursor: "pointer", fontSize: 13, lineHeight: "22px", padding: 0 }}
                          >×</button>
                        )}
                        {/* Portrait aspect ratio matches addendum paper (8.5×11); contain shows the full background */}
                        <div style={{ aspectRatio: "8.5 / 11", overflow: "hidden", background: "#fff" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img.url} alt={label} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                        </div>
                        <div style={{ padding: "5px 8px", fontSize: 10, color: "#55595c", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderTop: "1px solid #f0f0f0" }}>{label}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
