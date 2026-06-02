"use client";

interface Props {
  visible: boolean;
}

export default function PdfBuildingOverlay({ visible }: Props) {
  if (!visible) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#2a2b3c",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "Roboto, -apple-system, sans-serif",
    }}>
      {/* Branded tire loader — public/datire_loader.svg self-animates via
          embedded SMIL when referenced as an <img>. Don't inline the file
          (3,100+ lines); keep the URL reference so the browser caches it
          and the bundle stays light. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/datire_loader.svg?v=2" alt="" width={200} height={200} style={{ display: "block" }} />

      <p style={{ color: "#ffffff", fontSize: 18, fontWeight: 500, marginTop: 24, letterSpacing: "0.01em" }}>
        Building your addenda…
      </p>
      <p style={{ color: "#ffa500", fontSize: 13, marginTop: 8, opacity: 0.85 }}>
        Please wait, this may take a moment
      </p>
    </div>
  );
}
