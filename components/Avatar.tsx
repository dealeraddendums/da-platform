"use client";

import { useState } from "react";

// A person's circular photo (profiles.headshot_url, migration 172), or their
// initials on navy when there's no photo or it fails to load — never a broken
// image. Kept tiny and separate from HeadshotEditor so the chat bubble doesn't
// pull in the cropper.

const NAVY = "#2a2b3c";

export function initials(name?: string | null): string {
  const p = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase() || "?";
}

/** inverse: white circle + navy initials, for use on the navy chat header. */
export function Avatar({ url, name, size = 40, inverse = false }: { url: string | null; name?: string | null; size?: number; inverse?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (url && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" onError={() => setBroken(true)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", display: "block", flexShrink: 0, border: inverse ? "1px solid #fff" : "1px solid #e0e0e0" }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: inverse ? "#fff" : NAVY, color: inverse ? NAVY : "#fff", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 600 }}>
      {initials(name)}
    </div>
  );
}

