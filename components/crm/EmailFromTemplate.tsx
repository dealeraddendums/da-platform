"use client";

// "Email" on company / contact records: opens the composer in a slide-over
// (template picker included) and sends from support@ / feeds@ through
// Microsoft 365 — logged on the timeline and threaded in the Inbox.
// `link` renders the contact's address itself as the trigger (contact cards / contact page): TO is
// prefilled with that contact as a chip, the company is the compose context.

import { useState } from "react";
import SlideOver from "./SlideOver";
import { ComposeNew } from "./CompanyContextRail";

export default function EmailFromTemplate({ companyId, companyName, contactId, to, name, link, linkStyle }: {
  companyId?: string | null; companyName?: string | null; contactId?: string | null; to?: string | null; name?: string | null;
  link?: boolean; linkStyle?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <>
      {link && to
        ? <button type="button" className="crm-link" title={`Email ${name ?? to}`} onClick={() => { setOpen(true); setSent(false); }}
            style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", color: "var(--blue)", textAlign: "left", ...linkStyle }}>{to}</button>
        : <button type="button" className="btn btn-secondary" style={{ background: "#fff", height: 30, fontSize: 13 }} onClick={() => { setOpen(true); setSent(false); }}>Email</button>}
      {sent && <span style={{ fontSize: 12, color: "var(--success)", marginLeft: 8 }}>Sent — it&apos;s on the timeline.</span>}
      <SlideOver open={open} title={name ? `Email ${name}` : "New email"} onClose={() => setOpen(false)} width={760}>
        {open && <ComposeNew companyId={companyId ?? null} companyName={companyName ?? null} contactId={contactId ?? null} to={to ? [{ email: to, name: name ?? null }] : []}
          onDone={() => { setOpen(false); setSent(true); }} onCancel={() => setOpen(false)} />}
      </SlideOver>
    </>
  );
}
