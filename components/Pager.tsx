"use client";

// Shared list pager (Prev / page x of y / Next).
//
// Layout rule: the pager is CENTERED, never in the bottom-right corner —
// floating overlays live there (our Product Fruits life-ring launcher, browser
// extensions, desktop-app controls) and were covering the Next button on the
// Dealers list (2026-08-26). Three-zone flex keeps the optional summary
// ("Showing 1–50 of 480" / a per-page selector) on the left while the buttons
// stay truly centered, with the right third left empty as corner clearance.
// Keep every list's pagination on this component so the rule holds everywhere.

export default function Pager({
  page,
  totalPages,
  onPage,
  prevHref,
  nextHref,
  summary,
  light,
}: {
  page: number;
  totalPages: number;
  /** Button mode — called with the new page number. */
  onPage?: (p: number) => void;
  /** Link mode (server-rendered pages) — used when onPage is absent. */
  prevHref?: string;
  nextHref?: string;
  /** Left-zone content, e.g. "Showing 1–50 of 480" or a per-page selector. */
  summary?: React.ReactNode;
  /** White-on-dark text for lists that live on the dark page background. */
  light?: boolean;
}) {
  const muted = light ? "rgba(255,255,255,0.6)" : "var(--text-muted)";
  const linkStyle: React.CSSProperties = {
    border: "1px solid var(--border)",
    color: "var(--text-secondary)",
    background: "white",
  };
  return (
    <div className="flex items-center mt-4" style={{ position: "relative", zIndex: 5, paddingBottom: 4 }}>
      <div className="text-sm flex items-center gap-2" style={{ flex: 1, minWidth: 0, color: muted }}>
        {summary}
      </div>
      <div className="flex items-center gap-2">
        {totalPages <= 1 ? null : onPage ? (
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            ← Prev
          </button>
        ) : page > 1 && prevHref ? (
          <a href={prevHref} className="text-xs px-3 py-1 rounded" style={linkStyle}>← Prev</a>
        ) : null}
        {totalPages > 1 && (
          <span className="text-sm" style={{ color: muted }}>
            {page} / {totalPages}
          </span>
        )}
        {totalPages <= 1 ? null : onPage ? (
          <button className="btn btn-secondary" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
            Next →
          </button>
        ) : page < totalPages && nextHref ? (
          <a href={nextHref} className="text-xs px-3 py-1 rounded" style={linkStyle}>Next →</a>
        ) : null}
      </div>
      <div style={{ flex: 1, minWidth: 0 }} />
    </div>
  );
}
