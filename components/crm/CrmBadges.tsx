// DA-CRM badges — same shape as DecisionBadge (tinted bg, bold 11px, 3px radius).

const CALL_STATE: Record<string, { bg: string; fg: string; label: string }> = {
  completed: { bg: "#e8f5e9", fg: "#2e7d32", label: "Completed" },
  connected: { bg: "#e3f2fd", fg: "#1565c0", label: "In progress" },
  ringing:   { bg: "#e3f2fd", fg: "#1565c0", label: "Ringing" },
  voicemail: { bg: "#fff8e1", fg: "#7a5c00", label: "Voicemail" },
  missed:    { bg: "#ffebee", fg: "#b71c1c", label: "Missed" },
};

const ACTIVITY_TYPE: Record<string, { bg: string; fg: string; label: string }> = {
  call:          { bg: "#e3f2fd", fg: "#1565c0", label: "Call" },
  email:         { bg: "#ede7f6", fg: "#4527a0", label: "Email" },
  chat:          { bg: "#e0f2f1", fg: "#00695c", label: "Chat" },
  note:          { bg: "#fafafa", fg: "#616161", label: "Note" },
  status_change: { bg: "#fff8e1", fg: "#7a5c00", label: "Status" },
  task:          { bg: "#e8f5e9", fg: "#2e7d32", label: "Task" },
  ticket:        { bg: "#ffebee", fg: "#b71c1c", label: "Ticket" },
};

function Pill({ s }: { s: { bg: string; fg: string; label: string } }) {
  return (
    <span style={{ background: s.bg, color: s.fg, fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3, whiteSpace: "nowrap" }}>
      {s.label}
    </span>
  );
}

export function CallStateBadge({ state }: { state: string }) {
  return <Pill s={CALL_STATE[state] ?? { bg: "#fafafa", fg: "#616161", label: state }} />;
}

export function ActivityTypeBadge({ type }: { type: string }) {
  return <Pill s={ACTIVITY_TYPE[type] ?? { bg: "#fafafa", fg: "#616161", label: type }} />;
}

export function DirectionLabel({ direction }: { direction: string }) {
  const arrow = direction === "inbound" ? "↙" : direction === "outbound" ? "↗" : "•";
  return <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{arrow} {direction}</span>;
}
