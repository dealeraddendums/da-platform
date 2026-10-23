// DA-CRM badges — rounded soft tags (.crm-tag in crm-theme.css), one tone per meaning.

export type Tone = "success" | "warn" | "danger" | "accent" | "info" | "violet" | "neutral";

const CALL_STATE: Record<string, { tone: Tone; label: string }> = {
  completed: { tone: "success", label: "Completed" },
  connected: { tone: "info", label: "In progress" },
  ringing:   { tone: "info", label: "Ringing" },
  voicemail: { tone: "warn", label: "Voicemail" },
  missed:    { tone: "danger", label: "Missed" },
};

const ACTIVITY_TYPE: Record<string, { tone: Tone; label: string }> = {
  call:          { tone: "info", label: "Call" },
  email:         { tone: "violet", label: "Email" },
  chat:          { tone: "accent", label: "Chat" },
  note:          { tone: "neutral", label: "Note" },
  status_change: { tone: "warn", label: "Status" },
  task:          { tone: "success", label: "Task" },
  ticket:        { tone: "danger", label: "Ticket" },
};

export function Tag({ tone = "neutral", children, title, style }: { tone?: Tone; children: React.ReactNode; title?: string; style?: React.CSSProperties }) {
  return <span className="crm-tag" data-tone={tone} title={title} style={style}>{children}</span>;
}

export function CallStateBadge({ state }: { state: string }) {
  const s = CALL_STATE[state];
  return <Tag tone={s?.tone}>{s?.label ?? state}</Tag>;
}

export function ActivityTypeBadge({ type }: { type: string }) {
  const s = ACTIVITY_TYPE[type];
  return <Tag tone={s?.tone}>{s?.label ?? type}</Tag>;
}

export function DirectionLabel({ direction }: { direction: string }) {
  const arrow = direction === "inbound" ? "↙" : direction === "outbound" ? "↗" : "•";
  return <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{arrow} {direction}</span>;
}
