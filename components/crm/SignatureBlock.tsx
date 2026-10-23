"use client";

// The signature exactly as it goes out (GET /api/crm/signature/preview — same render + sanitizer as
// composeEmail). Compose window: read-only, greyed, labelled; Team → Signature passes `html` directly.
// Rendered in an isolated frame (no app CSS can restyle it; sandboxed: no scripts), sized to its content.
import { useEffect, useRef, useState } from "react";

export default function SignatureBlock({ html: given, label = "Signature — managed in Team" }: { html?: string | null; label?: string }) {
  const [html, setHtml] = useState<string | null | undefined>(given);
  const frame = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(96);
  useEffect(() => {
    if (given !== undefined) { setHtml(given); return; }
    let live = true;
    fetch("/api/crm/signature/preview").then((r) => r.json()).then((j) => live && setHtml(j.html ?? null)).catch(() => live && setHtml(null));
    return () => { live = false; };
  }, [given]);
  const fit = () => { const d = frame.current?.contentDocument; if (d?.body) setH(Math.min(400, d.body.scrollHeight + 4)); };
  return (
    <div aria-label="Email signature (read-only)" style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: "8px 12px", background: "var(--bg-subtle)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>{label}</div>
      {html === undefined ? <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</span>
        : html ? (
          <iframe ref={frame} title="Email signature" sandbox="allow-same-origin" onLoad={fit} scrolling="no"
            srcDoc={`<!doctype html><html><body style="margin:0;background:transparent;opacity:.85">${html}</body></html>`}
            style={{ width: "100%", height: h, border: 0, display: "block", pointerEvents: "none" }} />
        )
        : <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No signature — an admin sets it up under Team → Signature.</span>}
    </div>
  );
}
