// DA-CRM timeline — renders crm_activities newest first. Every module writes
// here, so this one component shows calls now and email/chat/tickets later.

import Link from "next/link";
import type { TimelineItem } from "@/lib/crm/queries";
import { ActivityTypeBadge, CallStateBadge } from "./CrmBadges";
import { fmtDateTime } from "@/lib/crm/format";

export default function Timeline({
  items, staff, contactNames = {}, showContact = true, anchors = false,
}: {
  items: TimelineItem[];
  staff: Record<string, string>;
  contactNames?: Record<string, string>;
  showContact?: boolean;
  /** id="act-{id}" on each row (the company page's Summary sources scroll to them). */
  anchors?: boolean;
}) {
  if (!items.length) {
    return <p className="text-sm" style={{ color: "var(--text-muted)", padding: 16, margin: 0 }}>No activity yet.</p>;
  }
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((a) => (
        <li key={a.id} id={anchors ? `act-${a.id}` : undefined} style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", scrollMarginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ActivityTypeBadge type={a.type} />
            {a.type === "call" && a.metadata?.state && <CallStateBadge state={a.metadata.state} />}
            <strong style={{ fontSize: 13 }}>{a.subject ?? a.type}</strong>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtDateTime(a.occurred_at)}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            {a.actor_staff_id && staff[a.actor_staff_id] && <span>{staff[a.actor_staff_id]}</span>}
            {showContact && a.contact_id && (
              <span>{a.actor_staff_id && staff[a.actor_staff_id] ? " · " : ""}
                <Link href={`/crm/contacts/${a.contact_id}`} style={{ color: "var(--blue)" }}>{contactNames[a.contact_id] ?? "Contact"}</Link>
              </span>
            )}
            {a.type === "call" && a.metadata?.call_id && (
              <span> · <Link href={`/crm/communications/calls?call=${a.metadata.call_id}`} style={{ color: "var(--blue)" }}>Call details</Link></span>
            )}
          </div>
          {a.body && (
            <p style={{ margin: "6px 0 0", fontSize: 13, whiteSpace: "pre-wrap", color: "var(--text-primary)" }}>{a.body}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
