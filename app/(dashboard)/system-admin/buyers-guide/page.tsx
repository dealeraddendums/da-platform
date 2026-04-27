"use client";

import { useEffect, useRef, useState } from "react";
import { BG_KEYS, BG_LABELS, type BgKey } from "@/lib/buyers-guide-constants";

type CardState = {
  loading: boolean;
  exists: boolean;
  url: string | null;
  uploading: boolean;
  seeding: boolean;
  error: string | null;
};

function makeEmpty(): CardState {
  return { loading: true, exists: false, url: null, uploading: false, seeding: false, error: null };
}

export default function BuyersGuidePdfsPage() {
  const [cards, setCards] = useState<Record<BgKey, CardState>>(() =>
    Object.fromEntries(BG_KEYS.map(k => [k, makeEmpty()])) as Record<BgKey, CardState>
  );
  const [seedingAll, setSeedingAll] = useState(false);
  const fileRefs = useRef<Partial<Record<BgKey, HTMLInputElement>>>({});

  function setCard(key: BgKey, patch: Partial<CardState>) {
    setCards(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function loadCard(key: BgKey) {
    setCard(key, { loading: true, error: null });
    try {
      const res = await fetch(`/api/system/buyers-guide-pdfs/${key}`);
      const j = await res.json() as { exists: boolean; url: string | null };
      setCard(key, { loading: false, exists: j.exists, url: j.url });
    } catch {
      setCard(key, { loading: false, error: "Failed to load" });
    }
  }

  useEffect(() => {
    BG_KEYS.forEach(k => void loadCard(k));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function seed(key: BgKey) {
    setCard(key, { seeding: true, error: null });
    try {
      const res = await fetch(`/api/system/buyers-guide-pdfs/${key}?action=seed`, { method: "POST" });
      const j = await res.json() as { ok?: boolean; url?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Seed failed");
      setCard(key, { seeding: false, exists: true, url: j.url ?? null });
    } catch (e) {
      setCard(key, { seeding: false, error: e instanceof Error ? e.message : "Seed failed" });
    }
  }

  async function upload(key: BgKey, file: File) {
    setCard(key, { uploading: true, error: null });
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/system/buyers-guide-pdfs/${key}`, { method: "PUT", body: fd });
      const j = await res.json() as { ok?: boolean; url?: string; error?: string };
      if (!res.ok) throw new Error(j.error ?? "Upload failed");
      setCard(key, { uploading: false, exists: true, url: j.url ?? null });
    } catch (e) {
      setCard(key, { uploading: false, error: e instanceof Error ? e.message : "Upload failed" });
    }
  }

  async function seedAll() {
    setSeedingAll(true);
    await Promise.all(BG_KEYS.map(k => seed(k)));
    setSeedingAll(false);
  }

  return (
    <div className="p-6">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: "#fff", margin: 0 }}>
            Buyer&apos;s Guide PDF Backgrounds
          </h1>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.65)", marginTop: 4, marginBottom: 0 }}>
            Manage the 4 system-default FTC Buyer&apos;s Guide backgrounds. Dealers may upload their own replacements.
          </p>
        </div>
        <button
          onClick={() => void seedAll()}
          disabled={seedingAll}
          style={{
            height: 36, padding: "0 18px", background: "#fff", border: "1px solid #e0e0e0",
            borderRadius: 4, fontSize: 13, fontWeight: 500, cursor: "pointer", color: "#333",
            opacity: seedingAll ? 0.6 : 1,
          }}
        >
          {seedingAll ? "Seeding…" : "Seed All from Local Files"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 900 }}>
        {BG_KEYS.map(key => {
          const c = cards[key];
          return (
            <div
              key={key}
              style={{
                background: "#fff",
                border: "1px solid #e0e0e0",
                borderRadius: 6,
                padding: "20px 20px 16px",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#2a2b3c" }}>
                    {BG_LABELS[key]}
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {c.loading ? (
                      <span style={{ fontSize: 11, color: "#78828c" }}>Loading…</span>
                    ) : c.exists ? (
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                        background: "#e8f5e9", color: "#2e7d32", border: "1px solid #c8e6c9",
                      }}>
                        Uploaded
                      </span>
                    ) : (
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 20,
                        background: "#fff3e0", color: "#e65100", border: "1px solid #ffe0b2",
                      }}>
                        Not seeded
                      </span>
                    )}
                  </div>
                </div>
                {c.url && (
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: "#1976d2", textDecoration: "none", marginTop: 2 }}
                  >
                    Preview ↗
                  </a>
                )}
              </div>

              {c.error && (
                <div style={{ fontSize: 12, color: "#c62828", marginBottom: 10 }}>{c.error}</div>
              )}

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  ref={el => { if (el) fileRefs.current[key] = el; }}
                  type="file"
                  accept="application/pdf"
                  style={{ display: "none" }}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) void upload(key, f);
                    e.target.value = "";
                  }}
                />
                <button
                  onClick={() => fileRefs.current[key]?.click()}
                  disabled={c.uploading || c.loading}
                  style={{
                    height: 32, padding: "0 14px", background: "#1976d2", color: "#fff",
                    border: "none", borderRadius: 4, fontSize: 12, fontWeight: 500, cursor: "pointer",
                    opacity: c.uploading ? 0.6 : 1,
                  }}
                >
                  {c.uploading ? "Uploading…" : c.exists ? "Replace PDF" : "Upload PDF"}
                </button>
                <button
                  onClick={() => void seed(key)}
                  disabled={c.seeding || c.loading}
                  style={{
                    height: 32, padding: "0 14px", background: "#fff", color: "#55595c",
                    border: "1px solid #e0e0e0", borderRadius: 4, fontSize: 12, cursor: "pointer",
                    opacity: c.seeding ? 0.6 : 1,
                  }}
                >
                  {c.seeding ? "Seeding…" : "Seed from Local"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: 28, padding: "14px 16px", background: "rgba(255,255,255,0.08)",
          borderRadius: 6, maxWidth: 900, fontSize: 12, color: "rgba(255,255,255,0.55)",
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "rgba(255,255,255,0.8)" }}>Seed vs Upload:</strong>{" "}
        &ldquo;Seed from Local&rdquo; extracts pages from the FTC source PDFs committed to the repo.
        &ldquo;Upload PDF&rdquo; lets you replace with a custom 2-page PDF (front + back).
        Dealers can upload their own version per key which takes priority over the system default.
        Local repo files are the final fallback if neither exists in storage.
      </div>
    </div>
  );
}
