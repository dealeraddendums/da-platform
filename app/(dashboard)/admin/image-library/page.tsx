"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export const dynamic = "force-dynamic";

interface ImageEntry {
  id: string | null;
  key: string;
  url: string;
  size: number;
  display_name: string;
  lastModified: string | null;
}

type TabBucket = "new-infobox-images" | "new-addendum-backgrounds" | "new-infosheet-backgrounds";

const TABS: {
  label: string;
  bucket: TabBucket;
  accept: string;
  maxMB: number;
  cols: number;
  aspectRatio: string;
  spec: string;
}[] = [
  {
    label: "Infobox Images",
    bucket: "new-infobox-images",
    accept: "image/png",
    maxMB: 5,
    cols: 4,
    aspectRatio: "553/339",
    spec: "Recommended size: 553 × 339 px · 150 DPI · PNG only · Max 5 MB",
  },
  {
    label: "Addendum Backgrounds",
    bucket: "new-addendum-backgrounds",
    accept: "image/png",
    maxMB: 5,
    cols: 5,
    aspectRatio: "638/1650",
    spec: "Standard: 638 × 1,650 px · Narrow: 469 × 1,650 px · 150 DPI · PNG only · Max 5 MB",
  },
  {
    label: "Infosheet Backgrounds",
    bucket: "new-infosheet-backgrounds",
    accept: "image/png",
    maxMB: 10,
    cols: 4,
    aspectRatio: "2657/3438",
    spec: "Recommended size: 2,657 × 3,438 px · 150 DPI · PNG only · Max 10 MB",
  },
];

function NameLabel({ img, onSaved }: { img: ImageEntry; onSaved: (id: string, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(img.display_name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === img.display_name) {
      setValue(img.display_name);
      setEditing(false);
      return;
    }
    if (!img.id) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/image-library/meta/${img.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: trimmed }),
      });
      if (res.ok) {
        onSaved(img.id, trimmed);
      } else {
        setValue(img.display_name);
      }
    } catch {
      setValue(img.display_name);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void save(); }
          if (e.key === "Escape") { setValue(img.display_name); setEditing(false); }
        }}
        disabled={saving}
        style={{
          width: "100%",
          fontSize: 11,
          fontWeight: 500,
          border: "1px solid #1976d2",
          borderRadius: 3,
          padding: "1px 4px",
          outline: "none",
          fontFamily: "inherit",
          color: "var(--text-primary)",
          background: "#fff",
          boxSizing: "border-box",
        }}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to rename"
      style={{
        fontSize: 11,
        color: "var(--text-primary)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        cursor: "text",
        padding: "1px 0",
      }}
    >
      {img.display_name}
    </div>
  );
}

export default function ImageLibraryPage() {
  const [activeTab, setActiveTab] = useState(0);
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
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
    setHoveredKey(null);
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

  function handleNameSaved(id: string, newName: string) {
    setImages((prev) => prev.map((img) => img.id === id ? { ...img, display_name: newName } : img));
  }

  return (
    <div>
      {/* Page heading */}
      <div className="mb-5">
        <h1 className="text-xl font-semibold" style={{ color: "var(--text-inverse)" }}>
          Image Library
        </h1>
        <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          Manage platform images for infoboxes and backgrounds
        </p>
      </div>

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

        {/* Specs banner */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 20px",
          background: "#e3f2fd",
          borderBottom: "1px solid #bbdefb",
          fontSize: 12,
          color: "#1565c0",
        }}>
          <span style={{ flexShrink: 0 }}>ℹ</span>
          {tab.spec}
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
            <div style={{
              display: "grid",
              gridTemplateColumns: `repeat(${tab.cols}, 1fr)`,
              gap: 16,
            }}>
              {images.map((img) => {
                const isDel = deletingKey === img.key;
                const isHovered = hoveredKey === img.key;
                return (
                  <div
                    key={img.key}
                    onMouseEnter={() => setHoveredKey(img.key)}
                    onMouseLeave={() => setHoveredKey(null)}
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      overflow: "hidden",
                      background: "#fff",
                      display: "flex",
                      flexDirection: "column",
                      position: "relative",
                    }}
                  >
                    {/* Hover trash icon */}
                    <button
                      onClick={() => handleDelete(img.key)}
                      disabled={isDel}
                      title="Delete image"
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        zIndex: 2,
                        width: 28,
                        height: 28,
                        borderRadius: 4,
                        border: "none",
                        background: isDel ? "rgba(0,0,0,0.4)" : "rgba(211,47,47,0.85)",
                        color: "#fff",
                        fontSize: 14,
                        cursor: isDel ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: isHovered || isDel ? 1 : 0,
                        transition: "opacity 0.15s",
                        fontFamily: "inherit",
                      }}
                    >
                      {isDel ? "…" : "🗑"}
                    </button>

                    {/* Image area with correct aspect ratio */}
                    <div style={{
                      aspectRatio: tab.aspectRatio,
                      background: "#f8f9fa",
                      border: "none",
                      borderBottom: "1px solid #e0e0e0",
                      overflow: "hidden",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.url}
                        alt={img.display_name}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "contain",
                          display: "block",
                        }}
                      />
                    </div>

                    {/* Caption with editable name */}
                    <div style={{ padding: "6px 8px" }}>
                      <NameLabel img={img} onSaved={handleNameSaved} />
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                        {(img.size / 1024).toFixed(0)} KB
                      </div>
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
