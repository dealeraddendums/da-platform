type Props = {
  email: string | null | undefined;
  /** When true, falls back to "—" instead of null for missing values */
  showDash?: boolean;
};

export function HubSpotEmail({ email, showDash = true }: Props) {
  if (!email) {
    return showDash ? <span style={{ color: "var(--text-muted)" }}>—</span> : null;
  }
  return (
    <a
      href={`https://app.hubspot.com/contacts/search?query=${encodeURIComponent(email)}`}
      target="_blank"
      rel="noopener noreferrer"
      title="Open in HubSpot"
      style={{ color: "var(--blue)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
      className="hover:underline"
    >
      {email}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, opacity: 0.65 }}>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  );
}
