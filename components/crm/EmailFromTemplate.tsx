"use client";

// "Email from template" on company / contact records. Until the Phase 2 Inbox
// can send, the rendered email (variables filled, signature appended) is
// copied as rich HTML for pasting into Outlook, and "Open in Outlook" starts a
// new message to the contact with the subject filled in.

import { useState } from "react";
import TemplatePicker, { RenderedPreview, type RenderedEmail } from "./TemplatePicker";

export default function EmailFromTemplate({ companyId, contactId, to }: { companyId?: string | null; contactId?: string | null; to?: string | null }) {
  const [open, setOpen] = useState(false);
  const [r, setR] = useState<RenderedEmail | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function copy() {
    if (!r) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([r.html], { type: "text/html" }),
        "text/plain": new Blob([r.text], { type: "text/plain" }),
      })]);
      setMsg("Copied — paste into the body of your Outlook message.");
    } catch {
      await navigator.clipboard.writeText(r.text).catch(() => undefined);
      setMsg("Your browser only allowed plain text — copied without formatting.");
    }
  }

  if (!open) return <button type="button" className="btn btn-secondary" style={{ background: "#fff", height: 30, fontSize: 13 }} onClick={() => setOpen(true)}>Email from template</button>;

  return (
    <div className="card" style={{ padding: 16, marginBottom: 16, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>Email from template</strong>
        <button type="button" className="btn btn-secondary" style={{ height: 28 }} onClick={() => { setOpen(false); setR(null); setMsg(null); }}>Close</button>
      </div>
      <TemplatePicker companyId={companyId} contactId={contactId} onRendered={(x) => { setR(x); setMsg(null); }} />
      {r && (
        <>
          <RenderedPreview r={r} />
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-primary" onClick={copy}>Copy email</button>
            {to && <a className="btn btn-secondary" href={`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(r.subject)}`}>Open in Outlook</a>}
            {msg && <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{msg}</span>}
          </div>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>Sending from DA-CRM (logged on the timeline) arrives with the Inbox in phase 2.</p>
        </>
      )}
    </div>
  );
}
