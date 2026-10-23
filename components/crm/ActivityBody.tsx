"use client";

// Timeline body: Safe Links unwrapped and shown short, capped at a few lines
// with Show more / Show less.

import { useMemo, useState } from "react";
import { PREVIEW_LINES, needsClamp, previewParts } from "@/lib/crm/preview-text";

export default function ActivityBody({ body }: { body: string }) {
  const parts = useMemo(() => previewParts(body), [body]);
  const clampable = useMemo(() => needsClamp(parts), [parts]);
  const [open, setOpen] = useState(false);
  const clamp = clampable && !open;
  return (
    <div style={{ marginTop: 6 }}>
      <p style={{
        margin: 0, fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-primary)",
        ...(clamp ? { display: "-webkit-box", WebkitLineClamp: PREVIEW_LINES, WebkitBoxOrient: "vertical" as const, overflow: "hidden" } : {}),
      }}>
        {parts.map((p, i) => "text" in p
          ? <span key={i}>{p.text}</span>
          : <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" title={p.href} className="crm-link">{p.label}</a>)}
      </p>
      {clampable && (
        <button type="button" className="crm-textlink" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
