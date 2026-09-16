// Signup-gate decision badge. Extracted from the trial-signups page so the
// server page (7-day summary chips) and the client queue table can share one
// style map instead of each carrying a copy.

export const DECISION_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  provisioned:        { bg: "#e8f5e9", fg: "#2e7d32", label: "Provisioned" },
  approved:           { bg: "#e8f5e9", fg: "#2e7d32", label: "Approved" },
  pending_review:     { bg: "#fff8e1", fg: "#7a5c00", label: "Pending review" },
  denied:             { bg: "#fafafa", fg: "#616161", label: "Denied" },
  blocked_afterhours: { bg: "#ede7f6", fg: "#4527a0", label: "After hours" },
  blocked_ratelimit:  { bg: "#ffebee", fg: "#b71c1c", label: "Rate limited" },
  blocked_domain:     { bg: "#ffebee", fg: "#b71c1c", label: "Bad domain" },
  blocked_invalid:    { bg: "#ffebee", fg: "#b71c1c", label: "Invalid" },
};

export default function DecisionBadge({ decision }: { decision: string }) {
  const s = DECISION_STYLE[decision] ?? { bg: "#fafafa", fg: "#616161", label: decision };
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}
