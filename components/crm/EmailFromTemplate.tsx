"use client";

// "Email" on company / contact records: opens the composer in a slide-over
// (template picker included) and sends from support@ / feeds@ through
// Microsoft 365 — logged on the timeline and threaded in the Inbox.

import { useState } from "react";
import SlideOver from "./SlideOver";
import { ComposeNew } from "./CompanyContextRail";

export default function EmailFromTemplate({ companyId, contactId, to }: { companyId?: string | null; contactId?: string | null; to?: string | null }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-secondary" style={{ background: "#fff", height: 30, fontSize: 13 }} onClick={() => { setOpen(true); setSent(false); }}>Email</button>
      {sent && <span style={{ fontSize: 12, color: "var(--success)", marginLeft: 8 }}>Sent — it&apos;s on the timeline.</span>}
      <SlideOver open={open} title="New email" onClose={() => setOpen(false)} width={760}>
        {open && <ComposeNew companyId={companyId ?? null} contactId={contactId ?? null} to={to ? [{ email: to }] : []}
          onDone={() => { setOpen(false); setSent(true); }} onCancel={() => setOpen(false)} />}
      </SlideOver>
    </>
  );
}
