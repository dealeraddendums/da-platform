"use client";

// DA-CRM email composer — new email, reply, reply all, forward. Sends through
// POST /api/crm/inbox/send (Microsoft Graph, as the mailbox; the server runs
// composeEmail(), which fills variables, makes it Outlook-safe and appends the
// sender's signature). Templates come from the shared TemplatePicker (body
// only — the signature is added at send).

import { useMemo, useRef, useState } from "react";
import EmailEditor from "./EmailEditor";
import TemplatePicker from "./TemplatePicker";

export type ComposerMode = "new" | "reply" | "replyAll" | "forward";
export type ComposerRecipient = { email: string; name?: string | null };
export type MailboxOption = { id: string; address: string; display_name: string };

const CAP = 20 * 1024 * 1024;
const LABEL: Record<ComposerMode, string> = { new: "New email", reply: "Reply", replyAll: "Reply all", forward: "Forward" };

export function formatRecipients(list: ComposerRecipient[] | undefined): string {
  return (list ?? []).map((r) => (r.name ? `${r.name} <${r.email}>` : r.email)).join(", ");
}

/** "Jane Doe <jane@x.com>, bob@y.com" → recipients (invalid entries returned separately). */
export function parseRecipients(text: string): { list: ComposerRecipient[]; bad: string[] } {
  const list: ComposerRecipient[] = [], bad: string[] = [];
  for (const part of text.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(part);
    const email = (m ? m[2] : part).trim().toLowerCase();
    const name = m ? m[1].trim().replace(/^"|"$/g, "") || null : null;
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { if (!list.some((r) => r.email === email)) list.push({ email, name }); }
    else bad.push(part);
  }
  return { list, bad };
}

export default function EmailComposer({
  mode, emailId, mailboxes, defaultMailboxId, companyId, contactId, initialTo, initialCc, initialSubject, onSent, onCancel,
}: {
  mode: ComposerMode;
  emailId?: string | null;              // message being answered
  mailboxes?: MailboxOption[];          // new compose: pick the mailbox
  defaultMailboxId?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  initialTo?: ComposerRecipient[];
  initialCc?: ComposerRecipient[];
  initialSubject?: string;
  onSent: (r: { email_id: string | null; thread_id: string | null }) => void;
  onCancel: () => void;
}) {
  const [mailboxId, setMailboxId] = useState(defaultMailboxId ?? mailboxes?.[0]?.id ?? "");
  const [to, setTo] = useState(formatRecipients(initialTo));
  const [cc, setCc] = useState(formatRecipients(initialCc));
  const [bcc, setBcc] = useState("");
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(initialSubject ?? "");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = useMemo(() => files.reduce((n, f) => n + f.size, 0), [files]);

  async function send() {
    const pTo = parseRecipients(to), pCc = parseRecipients(cc), pBcc = parseRecipients(bcc);
    const bad = [...pTo.bad, ...pCc.bad, ...pBcc.bad];
    if (bad.length) { setErr(`Not an email address: ${bad.join(", ")}`); return; }
    if (!pTo.list.length) { setErr("Add at least one recipient"); return; }
    if (!body.trim()) { setErr("Write a message (or pick a template)"); return; }
    if (total > CAP) { setErr("Attachments are over 20 MB"); return; }
    setBusy(true);
    setErr(null);
    const form = new FormData();
    form.append("payload", JSON.stringify({
      mode, email_id: emailId ?? null, mailbox_id: mode === "new" ? mailboxId || null : null,
      company_id: companyId ?? null, contact_id: contactId ?? null,
      to: pTo.list, cc: pCc.list, bcc: pBcc.list, subject, body_html: body,
    }));
    files.forEach((f) => form.append("attachments", f, f.name));
    const res = await fetch("/api/crm/inbox/send", { method: "POST", body: form });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't send"); return; }
    onSent({ email_id: j.email_id ?? null, thread_id: j.thread_id ?? null });
  }

  const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "64px 1fr", alignItems: "center", gap: 8 };
  return (
    <div style={{ display: "grid", gap: 10, padding: 16, background: "var(--bg-subtle)", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>{LABEL[mode]}</strong>
        <TemplatePicker companyId={companyId} contactId={contactId} signature={false}
          onRendered={(r) => { if (!r) return; setBody(r.html); if ((mode === "new" || !subject.trim()) && r.subject) setSubject(r.subject); }} />
      </div>
      {mode === "new" && (mailboxes?.length ?? 0) > 1 && (
        <div style={row}>
          <span className="label" style={{ margin: 0 }}>From</span>
          <select className="input" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            {mailboxes!.map((m) => <option key={m.id} value={m.id}>{m.display_name} &lt;{m.address}&gt;</option>)}
          </select>
        </div>
      )}
      <div style={row}>
        <span className="label" style={{ margin: 0 }}>To</span>
        <input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@dealer.com, Jane Doe <jane@dealer.com>" />
      </div>
      <div style={row}>
        <span className="label" style={{ margin: 0 }}>Cc</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} />
          {!showBcc && <button type="button" onClick={() => setShowBcc(true)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>Bcc</button>}
        </div>
      </div>
      {showBcc && (
        <div style={row}>
          <span className="label" style={{ margin: 0 }}>Bcc</span>
          <input className="input" value={bcc} onChange={(e) => setBcc(e.target.value)} />
        </div>
      )}
      <div style={row}>
        <span className="label" style={{ margin: 0 }}>Subject</span>
        <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <EmailEditor value={body} onChange={setBody} minHeight={200} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {files.map((f, i) => (
          <span key={`${f.name}-${i}`} style={{ fontSize: 12, background: "#fff", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px" }}>
            {f.name} · {Math.max(1, Math.round(f.size / 1024))} KB
            <button type="button" onClick={() => setFiles(files.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`}
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", marginLeft: 4 }}>×</button>
          </span>
        ))}
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={() => fileRef.current?.click()}>Attach files</button>
        <span style={{ fontSize: 11, color: total > CAP ? "var(--error)" : "var(--text-muted)" }}>{(total / 1048576).toFixed(1)} of 20 MB</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-primary" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Discard</button>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Your signature is added when it&apos;s sent.</span>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
    </div>
  );
}
