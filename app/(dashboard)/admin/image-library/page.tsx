"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export const dynamic = "force-dynamic";

interface ImageEntry {
  key: string;
  url: string;
  size: number;
  lastModified: string | null;
}

type TabBucket = "new-infobox-images" | "new-addendum-backgrounds" | "new-infosheet-backgrounds";

const TABS: { label: string; bucket: TabBucket; accept: string; maxMB: number }[] = [
  { label: "Infobox Images",        bucket: "new-infobox-images",        accept: "image/png", maxMB: 5  },
  { label: "Addendum Backgrounds",  bucket: "new-addendum-backgrounds",  accept: "image/png", maxMB: 5  },
  { label: "Infosheet Backgrounds", bucket: "new-infosheet-backgrounds", accept: "image/png", maxMB: 10 },
];

export default function ImageLibraryPage() {
  const [activeTab, setActiveTab] = useState(0);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const tab = TABS[activeTab];

  const loadImages = useCallback(async (bucket: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/image-library/${encodeURIComponent(bucket)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to load");
      setImages(d.images ?? []);
    } catch (e) {
      setError((e as Error).message);
      setImages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setImages([]);
    loadImages(tab.bucket);
  }, [activeTab, tab.bucket, loadImages]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    if (file.size > tab.maxMB * 1024 * 1024) {
      setUploadError(`File must be under ${tab.maxMB} MB`);
      e.target.value = "";
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bucket", tab.bucket);
      const res = await fetch("/api/admin/image-library/upload", { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Upload failed");
      await loadImages(tab.bucket);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  async function handleDelete(key: string) {
    if (!confirm(`Delete "${key.split("/").pop()}"?`)) return;
    setDeletingKey(key);
    try {
      const res = await fetch(
        `/api/admin/image-library/${encodeURIComponent(tab.bucket)}?key=${encodeURIComponent(key)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Delete failed");
      }
      setImages((prev) => prev.filter((img) => img.key !== key));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeletingKey(null);
    }
  }

  return (
    <div>
      {/* Page heading — white text on blue app background */}
      <div className="mb-5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          Image Library
        </h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          Manage platform images for infoboxes and backgrounds
        </p>
      </div>

      {/* White card container */}
      <div className="card overflow-hidden">
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
          {TABS.map((t, i) => (
            <button
              key={t.bucket}
              onClick={() => setActiveTab(i)}
              style={{
                padding: "10px 20px",
                fontSize: 13,
                fontWeight: i === activeTab ? 600 : 400,
                color: i === activeTab ? "#1976d2" : "var(--text-secondary)",
                background: "none",
                border: "none",
                borderBottom: i === activeTab ? "2px solid #1976d2" : "2px solid transparent",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Upload bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={fileRef}
            type="file"
            accept={tab.accept}
            onChange={handleUpload}
            style={{ display: "none" }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            style={{
              padding: "7px 16px",
              background: "#1976d2",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 500,
              cursor: uploading ? "not-allowed" : "pointer",
              opacity: uploading ? 0.7 : 1,
              fontFamily: "inherit",
            }}
          >
            {uploading ? "Uploading…" : "Upload Image"}
          </button>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            PNG only · max {tab.maxMB} MB
          </span>
          {uploadError && (
            <span style={{ fontSize: 12, color: "#d32f2f" }}>{uploadError}</span>
          )}
        </div>

        {/* Error */}
        {error && (
          <div style={{ margin: "12px 20px 0", padding: "10px 14px", background: "#ffebee", color: "#d32f2f", borderRadius: 4, fontSize: 13 }}>
            {error}
          </div>
        )}

        {/* Grid */}
        <div style={{ padding: 20 }}>
          {loading ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              Loading…
            </div>
          ) : images.length === 0 ? (
            <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
              No images yet. Upload one to get started.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
              {images.map((img) => {
                const name = img.key.split("/").pop() ?? img.key;
                const isDel = deletingKey === img.key;
                return (
                  <div
                    key={img.key}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      overflow: "hidden",
                      background: "#fff",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={name}
                      style={{ width: "100%", height: 130, objectFit: "cover", display: "block", background: "var(--bg-subtle)" }}
                    />
                    <div style={{ padding: "8px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-primary)",
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={name}
                      >
                        {name}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {(img.size / 1024).toFixed(0)} KB
                      </div>
                      <button
                        onClick={() => handleDelete(img.key)}
                        disabled={isDel}
                        style={{
                          marginTop: "auto",
                          padding: "4px 0",
                          background: isDel ? "var(--bg-subtle)" : "#ffebee",
                          color: "#d32f2f",
                          border: "1px solid #ffcdd2",
                          borderRadius: 3,
                          fontSize: 11,
                          cursor: isDel ? "not-allowed" : "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {isDel ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
