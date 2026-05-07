"use client";

import { useState, useEffect } from "react";

interface ImageEntry {
  key: string;
  url: string;
  size: number;
  display_name?: string;
}

interface ImagePickerModalProps {
  bucket: string;
  title?: string;
  onSelect: (url: string) => void;
  onClose: () => void;
}

export default function ImagePickerModal({
  bucket,
  title,
  onSelect,
  onClose,
}: ImagePickerModalProps) {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    fetch(`/api/admin/image-library/${encodeURIComponent(bucket)}`)
      .then((r) => r.json())
      .then((d) => setImages(d.images ?? []))
      .catch(() => setImages([]))
      .finally(() => setLoading(false));
  }, [bucket]);

  const filtered = images.filter((img) => {
    const name = img.display_name ?? img.key.split("/").pop() ?? img.key;
    return name.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.5)",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 8,
          width: 700,
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 8px 32px rgba(0,0,0,.22)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 20px",
            borderBottom: "1px solid #e0e0e0",
            background: "#2a2b3c",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>
            {title ?? "Choose Image"}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,.7)",
              cursor: "pointer",
              fontSize: 20,
              lineHeight: 1,
              padding: "0 4px",
            }}
          >
            ✕
          </button>
        </div>

        {/* Search */}
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #e0e0e0",
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search images…"
            style={{
              width: "100%",
              padding: "6px 10px",
              border: "1px solid #e0e0e0",
              borderRadius: 4,
              fontSize: 13,
              boxSizing: "border-box",
              fontFamily: "inherit",
            }}
          />
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {loading ? (
            <div
              style={{ textAlign: "center", padding: 48, color: "#78828c", fontSize: 13 }}
            >
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div
              style={{ textAlign: "center", padding: 48, color: "#78828c", fontSize: 13 }}
            >
              No images found
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 12,
              }}
            >
              {filtered.map((img) => {
                const label = img.display_name ?? img.key.split("/").pop() ?? img.key;
                return (
                  <div
                    key={img.key}
                    onClick={() => onSelect(img.url)}
                    title={label}
                    style={{
                      cursor: "pointer",
                      border: "2px solid #e0e0e0",
                      borderRadius: 6,
                      overflow: "hidden",
                      background: "#f5f6f7",
                      transition: "border-color .15s",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = "#1976d2";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.borderColor = "#e0e0e0";
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={label}
                      style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }}
                    />
                    <div
                      style={{
                        padding: "5px 8px",
                        fontSize: 10,
                        color: "#55595c",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {label}
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
