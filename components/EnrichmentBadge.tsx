// Google-Places enrichment outcome badge for a provisioned signup's dealer.
//
// Extracted from app/(dashboard)/admin/trial-signups/page.tsx so the server
// page (summary chips) and the client queue component (table cells) can both
// render it without duplicating the style map. No hooks — safe in either.

export interface EnrichRow {
  dealer_uuid: string;
  enrichment_status: string;
  enrichment_name_score: number | null;
  matched_name: string | null;
  notes: string | null;
}

export const ENRICH_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  confirmed:    { bg: "#e8f5e9", fg: "#2e7d32", label: "Confirmed" },
  needs_review: { bg: "#fff8e1", fg: "#7a5c00", label: "Needs review" },
  no_match:     { bg: "#fafafa", fg: "#616161", label: "No match" },
  error:        { bg: "#ffebee", fg: "#b71c1c", label: "Lookup failed" },
};

export default function EnrichmentBadge({ row }: { row: EnrichRow | undefined }) {
  if (!row) return <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>;
  const s = ENRICH_STYLE[row.enrichment_status]
    ?? { bg: "#fafafa", fg: "#616161", label: row.enrichment_status };
  const score = row.enrichment_name_score != null ? Number(row.enrichment_name_score).toFixed(2) : null;
  return (
    <span
      title={[row.matched_name && `Google: ${row.matched_name}`, score && `name score ${score}`, row.notes]
        .filter(Boolean).join(" · ")}
      style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}
    >
      {s.label}{score && row.enrichment_status !== "no_match" ? ` ${score}` : ""}
    </span>
  );
}
