"use client";

// Shared types + small UI pieces for the super_admin LogoForge dashboard
// (/admin/logoforge). Every call goes through /api/admin/logoforge/* — the
// browser never talks to the LogoForge service directly.

import type { CSSProperties, ReactNode } from "react";

export type LibAsset = {
  id: string;
  make: string;
  make_key: string;
  variant: { era: "current" | "legacy"; form: "emblem" | "wordmark" | "lockup"; color: string };
  status: "replacement_ready" | "legacy_reference" | "awaiting_asset";
  replacement_ok: boolean;
  file: string;
  sha256: string | null;
  license_note: string;
  notes?: string;
  origin?: string;
  updated_by?: string | null;
  updated_at?: string | null;
  added_at?: string;
  source?: { kind?: string; by?: string; repo?: string };
};

export type LibraryResponse = {
  counts: Record<string, number>;
  problems: string[];
  assets: LibAsset[];
  license_policy: string;
  writable: boolean;
};

export type TemplateSummary = {
  id: string;
  name?: string;
  description?: string;
  slots?: { id: string; label: string; required: boolean; aliases: string[]; font: string; max_chars: number }[];
  fixed?: { id: string; kind: string; source: string }[];
  fonts?: string[];
  license_note?: string;
  origin?: string;
  updated_at?: string | null;
  updated_by?: string | null;
  error?: string;
};

export const STATUS_LABEL: Record<string, string> = {
  replacement_ready: "Replacement ready",
  legacy_reference: "Legacy reference",
  awaiting_asset: "Awaiting asset",
};

export const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  replacement_ready: { bg: "#e8f5e9", fg: "#2e7d32" },
  legacy_reference: { bg: "#fff3e0", fg: "#e65100" },
  awaiting_asset: { bg: "#eceff1", fg: "#546e7a" },
};

export function Badge({ children, bg, fg, title }: { children: ReactNode; bg: string; fg: string; title?: string }) {
  return (
    <span title={title} style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600,
      background: bg, color: fg, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLOR[status] ?? STATUS_COLOR.awaiting_asset;
  return <Badge bg={c.bg} fg={c.fg}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export function EditedBadge({ by, at }: { by?: string | null; at?: string | null }) {
  return (
    <Badge bg="#e3f2fd" fg="#1565c0" title={`Edited in the dashboard${by ? ` by ${by}` : ""}${at ? ` · ${fmtDate(at)}` : ""}`}>
      Edited
    </Badge>
  );
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export const ERROR_BOX: CSSProperties = {
  padding: "8px 12px", background: "#ffebee", border: "1px solid #ffcdd2", borderRadius: 4,
  fontSize: 13, color: "#c62828",
};

export const INFO_BOX: CSSProperties = {
  padding: "8px 12px", background: "#e3f2fd", border: "1px solid #bbdefb", borderRadius: 4,
  fontSize: 13, color: "#1565c0",
};

export const WARN_BOX: CSSProperties = {
  padding: "8px 12px", background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 4,
  fontSize: 13, color: "#7a5c00",
};

export const MUTED: CSSProperties = { fontSize: 12, color: "var(--text-muted)" };

/** Persistent modal: closes only via its own controls (no backdrop click, no Escape) — platform policy. */
export function Modal({ title, onClose, children, width = 820, footer }: {
  title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto",
    }}>
      <div className="card" style={{ width: "100%", maxWidth: width, background: "var(--bg-surface)" }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 20px", borderBottom: "1px solid var(--border)",
        }}>
          <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>{title}</p>
          <button onClick={onClose} aria-label="Close"
            style={{ background: "none", border: "none", fontSize: 22, lineHeight: 1, cursor: "pointer", color: "var(--text-muted)" }}>
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
        {footer && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--border)" }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/** A PNG on a white tile (OEM marks are only ever shown on white). */
export function PngTile({ src, alt, height = 110 }: { src: string | null; alt: string; height?: number }) {
  return (
    <div style={{
      height, background: "#fff", border: "1px solid var(--border)", borderRadius: 4,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 8, overflow: "hidden",
    }}>
      {src
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={src} alt={alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        : <span style={MUTED}>—</span>}
    </div>
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/logoforge/${path}`, { cache: "no-store", ...init });
  const j = await res.json().catch(() => ({})) as { error?: string };
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j as T;
}

export function downloadBlob(data: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "logo";
}
