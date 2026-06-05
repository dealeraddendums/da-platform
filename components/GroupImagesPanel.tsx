"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface GroupImage {
  id: string;
  bucket: string;
  s3_key: string;
  url: string;
  display_name: string;
  file_size: number | null;
  uploaded_at: string | null;
}

const CATEGORIES: { bucket: string; label: string; maxMB: number }[] = [
  { bucket: "new-addendum-backgrounds", label: "Addendum Backgrounds", maxMB: 5 },
  { bucket: "new-infosheet-backgrounds", label: "Info Sheet Backgrounds", maxMB: 10 },
  { bucket: "new-infobox-images", label: "Infobox / Logo Images", maxMB: 5 },
];

export default function GroupImagesPanel({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);
  const [images, setImages] = useState<GroupImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState(CATEGORIES[0].bucket);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/groups/${groupId}/images`)
      .then((r) => r.json())
      .then((d) => setImages(d.images ?? []))
      .catch(() => setImages([]))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const doUpload = useCallback(async (file: File) => {
    setError("");
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bucket", category);
      const res = await fetch(`/api/groups/${groupId}/images`, { method: "POST", body: fd });
      const json = await res.json().catch(() => ({}));
      if (res.status === 201) load();
      else setError(json.error ?? `Upload failed (${res.status})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [groupId, category, load]);

  const doDelete = useCallback(async (img: GroupImage) => {
    if (!confirm(`Delete "${img.display_name}"? Dealers in this group will lose access to it.`)) return;
    const res = await fetch(`/api/groups/${groupId}/images?imageId=${encodeURIComponent(img.id)}`, { method: "DELETE" });
    if (res.ok) setImages((prev) => prev.filter((i) => i.id !== img.id));
    else { const j = await res.json().catch(() => ({})); setError(j.error ?? "Delete failed"); }
  }, [groupId]);

  const doRename = useCallback(async (img: GroupImage) => {
    const name = prompt("Rename image", img.display_name);
    if (!name || name.trim() === img.display_name) return;
    const res = await fetch(`/api/groups/${groupId}/images?imageId=${encodeURIComponent(img.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ display_name: name.trim() }),
    });
    if (res.ok) setImages((prev) => prev.map((i) => (i.id === img.id ? { ...i, display_name: name.trim() } : i)));
    else { const j = await res.json().catch(() => ({})); setError(j.error ?? "Rename failed"); }
  }, [groupId]);

  const maxMB = CATEGORIES.find((c) => c.bucket === category)?.maxMB ?? 5;

  return (
    <div className="card" style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 6, padding: 0, marginTop: 24 }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", padding: "16px 20px" }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#2a2b3c" }}>Group Image Library</div>
          <div style={{ fontSize: 12, color: "#78828c", marginTop: 2 }}>
            Images here are available to every dealer in this group, in the Builder picker.
          </div>
        </div>
        <span style={{ color: "#78828c" }}>{open ? "▼" : "▶"}</span>
      </div>

      {open && (
        <div style={{ borderTop: "1px solid #e0e0e0", padding: 20 }}>
          {/* Upload bar */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              style={{ padding: "7px 10px", border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 13, fontFamily: "inherit", cursor: "pointer" }}>
              {CATEGORIES.map((c) => <option key={c.bucket} value={c.bucket}>{c.label}</option>)}
            </select>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void doUpload(f); }} />
            <button onClick={() => fileRef.current?.click()} disabled={uploading}
              style={{ padding: "7px 14px", background: uploading ? "#9aa4ad" : "#1976d2", color: "#fff", border: "none", borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: uploading ? "default" : "pointer" }}>
              {uploading ? "Uploading…" : "Upload Image"}
            </button>
            <span style={{ fontSize: 12, color: "#78828c" }}>PNG/JPG/WebP, up to {maxMB} MB</span>
          </div>

          {error && <div style={{ padding: "8px 12px", background: "#fdecea", color: "#c62828", fontSize: 12, borderRadius: 4, marginBottom: 12 }}>{error}</div>}

          {loading ? (
            <div style={{ textAlign: "center", padding: 32, color: "#78828c", fontSize: 13 }}>Loading…</div>
          ) : images.length === 0 ? (
            <div style={{ textAlign: "center", padding: 32, color: "#78828c", fontSize: 13 }}>
              No group images yet. Upload one above — it&apos;ll appear in every dealer&apos;s Builder picker.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
              {images.map((img) => (
                <div key={img.id} style={{ border: "1px solid #e0e0e0", borderRadius: 6, overflow: "hidden", background: "#f5f6f7" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt={img.display_name} style={{ width: "100%", height: 110, objectFit: "cover", display: "block" }} />
                  <div style={{ padding: "6px 8px" }}>
                    <div style={{ fontSize: 11, color: "#333", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={img.display_name}>{img.display_name}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 5 }}>
                      <button onClick={() => void doRename(img)} style={{ background: "none", border: "none", color: "#1976d2", fontSize: 11, cursor: "pointer", padding: 0 }}>Rename</button>
                      <button onClick={() => void doDelete(img)} style={{ background: "none", border: "none", color: "#c62828", fontSize: 11, cursor: "pointer", padding: 0 }}>Delete</button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
