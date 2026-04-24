"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ImageItem { key: string; url: string; }

type Props = {
  title?: string;
  // Library mode: Tab 1 shows S3 image grid
  listEndpoint?: string;
  tab1Label?: string;
  // Current-image mode: Tab 1 shows existing image + remove
  currentImageUrl?: string | null;
  onRemove?: () => void;
  // Upload config
  uploadBucket: string;
  uploadKeyPrefix?: string;
  acceptedTypes?: string;
  maxSizeMB?: number;
  // Callbacks
  onSelect: (url: string) => void;
  onClose: () => void;
};

export default function ImageUploadPicker({
  title = "Choose Image",
  listEndpoint,
  tab1Label,
  currentImageUrl,
  onRemove,
  uploadBucket,
  uploadKeyPrefix = "",
  acceptedTypes = "image/png,image/jpeg,image/jpg",
  maxSizeMB = 5,
  onSelect,
  onClose,
}: Props) {
  const hasTab1 = listEndpoint != null || currentImageUrl !== undefined;
  const [tab, setTab] = useState<"tab1" | "upload">(hasTab1 ? "tab1" : "upload");
  const [images, setImages] = useState<ImageItem[]>([]);
  const [loadingLib, setLoadingLib] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const actualTab1Label = tab1Label ?? (listEndpoint ? "Library" : "Current");
  const typeDisplay = acceptedTypes.replace(/image\//gi, "").toUpperCase().replace(/,/g, ", ");

  useEffect(() => {
    if (tab !== "tab1" || !listEndpoint) return;
    if (images.length > 0) return;
    setLoadingLib(true);
    fetch(listEndpoint)
      .then(r => r.json() as Promise<{ images?: ImageItem[] }>)
      .then(j => setImages(j.images ?? []))
      .catch(() => setImages([]))
      .finally(() => setLoadingLib(false));
  }, [tab, listEndpoint, images.length]);

  const handleFileSelect = useCallback((file: File) => {
    setUploadError(null);
    const allowed = acceptedTypes.split(",").map(t => t.trim());
    if (!allowed.includes(file.type)) {
      setUploadError(`Allowed types: ${typeDisplay}`);
      return;
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      setUploadError(`File must be under ${maxSizeMB} MB`);
      return;
    }
    setUploadFile(file);
  }, [acceptedTypes, maxSizeMB, typeDisplay]);

  async function handleUpload() {
    if (!uploadFile) return;
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("file", uploadFile);
      fd.append("bucket", uploadBucket);
      fd.append("keyPrefix", uploadKeyPrefix);
      const res = await fetch("/api/upload-image", { method: "POST", body: fd });
      const json = await res.json() as { url?: string; error?: string };
      if (!res.ok) { setUploadError(json.error ?? "Upload failed"); return; }
      if (json.url) {
        const newItem = { key: json.url, url: json.url };
        setImages(prev => [newItem, ...prev]);
        onSelect(json.url);
        onClose();
      }
    } finally {
      setUploading(false);
    }
  }

  const filtered = listEndpoint
    ? images.filter(img => !searchQ || img.key.toLowerCase().includes(searchQ.toLowerCase()))
    : images;

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "9px 18px", fontSize: 13, fontWeight: active ? 600 : 400,
    color: active ? "#1976d2" : "#55595c", background: "none", border: "none",
    borderBottom: active ? "2px solid #1976d2" : "2px solid transparent",
    marginBottom: -1, cursor: "pointer", fontFamily: "inherit",
  });

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: "#fff", borderRadius: 6, width: 560, maxWidth: "92vw", maxHeight: "82vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "14px 18px", background: "#2a2b3c", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: "#fff" }}>{title}</span>
          <button onClick={onClose} style={{ fontSize: 20, color: "rgba(255,255,255,0.7)", lineHeight: 1, background: "none", border: "none", cursor: "pointer" }}>×</button>
        </div>

        {/* Tabs */}
        {hasTab1 && (
          <div style={{ display: "flex", borderBottom: "1px solid #e0e0e0", paddingLeft: 18, flexShrink: 0, background: "#fff" }}>
            <button style={tabBtn(tab === "tab1")} onClick={() => setTab("tab1")}>{actualTab1Label}</button>
            <button style={tabBtn(tab === "upload")} onClick={() => setTab("upload")}>Upload New</button>
          </div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", padding: 18 }}>

          {/* Library tab */}
          {tab === "tab1" && listEndpoint && (
            <div>
              {listEndpoint && (
                <input value={searchQ} onChange={e => setSearchQ(e.target.value)}
                  placeholder="Search images…"
                  style={{ width: "100%", padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, marginBottom: 14, boxSizing: "border-box", outline: "none" }} />
              )}
              {loadingLib ? (
                <div style={{ textAlign: "center", padding: 32, color: "#78828c" }}>Loading…</div>
              ) : filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: 32, color: "#78828c" }}>
                  {images.length === 0 ? "No images yet. Upload one to get started." : "No images match."}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {filtered.map(img => (
                    <div key={img.key} onClick={() => setSelectedUrl(img.url)}
                      style={{ cursor: "pointer", border: `2px solid ${selectedUrl === img.url ? "#1976d2" : "#e0e0e0"}`, borderRadius: 4, overflow: "hidden", background: "#f5f6f7", aspectRatio: "1" }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Current-image tab */}
          {tab === "tab1" && !listEndpoint && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "12px 0" }}>
              {currentImageUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={currentImageUrl} alt="Current" style={{ maxWidth: "100%", maxHeight: 200, objectFit: "contain", border: "1px solid #e0e0e0", borderRadius: 4 }} />
                  {onRemove && (
                    <button onClick={onRemove} style={{ padding: "6px 16px", background: "#fff", border: "1px solid #ff5252", borderRadius: 4, color: "#ff5252", fontSize: 13, cursor: "pointer" }}>
                      Remove
                    </button>
                  )}
                </>
              ) : (
                <div style={{ textAlign: "center", padding: 32, color: "#78828c" }}>No image set</div>
              )}
            </div>
          )}

          {/* Upload tab */}
          {tab === "upload" && (
            <div>
              <div
                onClick={() => fileRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFileSelect(f); }}
                style={{ border: "2px dashed #e0e0e0", borderRadius: 6, padding: "32px 16px", textAlign: "center", cursor: "pointer", background: "#fafafa", marginBottom: 14 }}
              >
                <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.35 }}>↑</div>
                <div style={{ fontSize: 14, color: "#55595c", marginBottom: 4 }}>Drag & drop or click to browse</div>
                <div style={{ fontSize: 11, color: "#78828c" }}>{typeDisplay} · Max {maxSizeMB} MB</div>
              </div>
              <input ref={fileRef} type="file" accept={acceptedTypes} style={{ display: "none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
              {uploadFile && (
                <div style={{ marginBottom: 10, padding: "8px 12px", background: "#f5f6f7", borderRadius: 4, fontSize: 13, color: "#55595c" }}>
                  Selected: {uploadFile.name} ({(uploadFile.size / 1024).toFixed(0)} KB)
                </div>
              )}
              {uploadError && <p style={{ color: "#ff5252", fontSize: 12, marginBottom: 8 }}>{uploadError}</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "12px 18px", borderTop: "1px solid #e0e0e0", display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0 }}>
          <button onClick={onClose} style={{ padding: "7px 16px", background: "#fff", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, cursor: "pointer", color: "#55595c" }}>Cancel</button>
          {tab === "tab1" && listEndpoint && selectedUrl && (
            <button onClick={() => { onSelect(selectedUrl); onClose(); }}
              style={{ padding: "7px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Use This Image
            </button>
          )}
          {tab === "upload" && uploadFile && (
            <button onClick={() => void handleUpload()} disabled={uploading}
              style={{ padding: "7px 16px", background: "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: uploading ? 0.6 : 1 }}>
              {uploading ? "Uploading…" : "Upload & Use"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
