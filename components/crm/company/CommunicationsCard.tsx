"use client";

// Company page → Communications: one card, tabs Email | Chat | Calls.
// Email: this company's threads, opened and replied to inline (EmailThreadsPanel).
// Chat: Steven conversations — the Chat module isn't merged yet, so a stub.
// Calls: playback, AI recap and transcript per call (CallsTable), click-to-call in the tab header.
// Other cards switch tabs with window event "crm:comms" { tab } (e.g. a task's
// "Open chat to reply"; the timeline's thread titles pass { tab: "email", thread }).

import { useEffect, useRef, useState } from "react";
import EmailThreadsPanel, { type ThreadCounts } from "@/components/crm/EmailThreadsPanel";
import CallsTable from "@/components/crm/CallsTable";
import ClickToCall from "@/components/crm/ClickToCall";
import type { CallListRow } from "@/lib/crm/queries";

type Tab = "email" | "chat" | "calls";

export default function CommunicationsCard({ companyId, companyName, meId, to, calls, emailCounts, phone, canDial }: {
  companyId: string; companyName: string; meId: string; to: { email: string; name?: string }[];
  calls: CallListRow[]; emailCounts: { active: number; all: number }; phone: string | null; canDial: boolean;
}) {
  const [tab, setTab] = useState<Tab>("email");
  // The Email tab counts what the panel's filter shows (Open by default); the total is in the tooltip.
  const [email, setEmail] = useState<ThreadCounts>({ shown: emailCounts.active, filter: "active", active: emailCounts.active, closed: emailCounts.all - emailCounts.active, all: emailCounts.all });
  const ref = useRef<HTMLElement>(null);
  // A thread the timeline asked to open (crm:comms { tab: "email", thread }); the panel opens it.
  const [openThread, setOpenThread] = useState<{ id: string; at: number } | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent).detail?.tab as Tab | undefined;
      if (t === "email" || t === "chat" || t === "calls") { setTab(t); ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }
      const th = (e as CustomEvent).detail?.thread as string | undefined;
      if (t === "email" && th) setOpenThread({ id: th, at: Date.now() });
    };
    window.addEventListener("crm:comms", on);
    return () => window.removeEventListener("crm:comms", on);
  }, []);

  const tabs: [Tab, string, number | null, string?][] = [
    ["email", "Email", email.shown, `${email.active} open · ${email.closed} closed · ${email.all} total`],
    ["chat", "Chat", null], ["calls", "Calls", calls.length]];

  return (
    <section ref={ref} className="crm-card" id="communications" style={{ scrollMarginTop: 12 }}>
      <div className="crm-card-head">
        <h2>Communications</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {tab === "calls" && phone && <ClickToCall phone={phone} canDial={canDial} />}
          <div className="crm-tabs" role="tablist" aria-label="Communications">
            {tabs.map(([k, label, n, tip]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className="crm-tab" title={tip} onClick={() => setTab(k)}>
                {label}{n != null && <span className="crm-count">{n}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
      {tab === "email" && <EmailThreadsPanel companyId={companyId} companyName={companyName} meId={meId} to={to} filter={email.filter} onCounts={setEmail} openThread={openThread} />}
      {tab === "chat" && (
        <div className="crm-empty">
          <strong>Chat is coming soon</strong>
          Steven hand-offs for this company will show here to read and reply. Until then they arrive through Help Center → Conversations.
        </div>
      )}
      {tab === "calls" && (calls.length ? <CallsTable rows={calls} showCompany={false} /> : (
        <div className="crm-empty">
          <strong>No calls yet</strong>
          Calls made or taken in Dialpad appear here with a recap and transcript.
        </div>
      ))}
    </section>
  );
}
