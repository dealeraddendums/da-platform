"use client";

import { useRef, useState } from "react";

type Props = {
  dealerId: string;
  currentLogoUrl: string | null;
  onUpdated: (newUrl: string | null) => void;
};

export default function DealerLogoUploader({ dealerId, currentLogoUrl, onUpdated }: Props) {
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setError(null);
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
    if (!allowed.includes(file.type)) {
      setError("Only PNG, JPG, or SVG files are allowed.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("File must be under 2 MB.");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/dealers/${dealerId}/logo`, { method: "POST", body: fd });
      const json = await res.json() as { logo_url?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setLogoUrl(json.logo_url!);
      onUpdated(json.logo_url!);
      showToast();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleRemove() {
    setError(null);
    setUploading(true);
    try {
      const res = await fetch(`/api/dealers/${dealerId}/logo`, { method: "DELETE" });
      if (!res.ok) throw new Error("Remove failed");
      setLogoUrl(null);
      onUpdated(null);
      showToast();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed");
    } finally {
      setUploading(false);
    }
  }

  function showToast() {
    setToast(true);
    setTimeout(() => setToast(false), 2500);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
        {/* Preview */}
        <div
          style={{
            width: 180, height: 80, border: "1px solid var(--border)", borderRadius: 4,
            background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, overflow: "hidden",
          }}
        >
          {logoUrl ? (
            <img
              src={`${logoUrl}?t=${Date.now()}`}
              alt="Dealer logo"
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", display: "block" }}
            />
          ) : (
            <span style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", padding: "0 12px" }}>
              No logo uploaded
            </span>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/svg+xml"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.[0]) void handleFile(e.target.files[0]); }}
          />
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, height: 30, padding: "0 12px" }}
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? "Uploading…" : logoUrl ? "Replace Logo" : "Upload Logo"}
          </button>
          {logoUrl && (
            <button
              className="btn btn-secondary"
              style={{ fontSize: 12, height: 30, padding: "0 12px" }}
              disabled={uploading}
              onClick={() => void handleRemove()}
            >
              Remove Logo
            </button>
          )}
          <p className="text-xs" style={{ color: "var(--text-muted)", marginTop: 2 }}>
            PNG, JPG, or SVG · Max 2 MB
          </p>
        </div>
      </div>

      {error && (
        <p className="text-xs mt-2" style={{ color: "var(--error)" }}>{error}</p>
      )}
      {toast && (
        <p className="text-xs mt-2" style={{ color: "var(--success)" }}>Logo updated</p>
      )}
    </div>
  );
}
