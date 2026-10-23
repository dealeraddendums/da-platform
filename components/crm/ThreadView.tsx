"use client";

// One email thread: header controls (status, assignee, linked company /
// contact), the messages (all collapsed except the latest), internal notes in
// line, reply / reply all / forward with the composer, and an internal-note
// box. Used by the Inbox's middle pane and by the Email-tab slide-over on
// company / contact pages.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import EmailComposer, { type ComposerMode, type ComposerRecipient } from "./EmailComposer";
import { displaySubject, mailboxLabel } from "@/lib/crm/thread-display";

type Addr = { email: string; name: string | null };
type Email = {
  id: string; direction: "inbound" | "outbound"; from_email: string | null; from_name: string | null;
  to: Addr[]; cc: Addr[]; bcc: Addr[]; subject: string | null; html: string; text: string | null; received_at: string;
  sent_by_name: string | null; is_reply_all: boolean; attachments: { id: string; filename: string; size: number | null; available: boolean }[];
};
type Note = { id: string; body: string; occurred_at: string; author: string | null };
type Thread = {
  id: string; subject: string | null; status: "open" | "waiting_on_dealer" | "closed"; internal: boolean;
  company_id: string | null; contact_id: string | null; company_name: string | null; contact_name: string | null;
  assigned_staff_id: string | null; matched_by: string | null; candidates: { id: string; name: string }[];
  mailbox: { id: string; address: string; display_name: string; purpose: string } | null;
};
type Detail = { thread: Thread; emails: Email[]; notes: Note[]; staff: { id: string; name: string }[] };

export const STATUS_LABEL: Record<string, string> = { open: "Open", waiting_on_dealer: "Waiting on dealer", closed: "Closed" };

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const who = (a: { email: string | null; name: string | null }) => a.name || a.email || "Unknown";
const list = (xs: Addr[]) => xs.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");

export default function ThreadView({
  threadId, meId, onChanged, onContext, replyRequest,
}: {
  threadId: string;
  meId: string;
  onChanged?: () => void;
  /** The linked company / contact changed (the Inbox points its rail at it). */
  onContext?: (companyId: string | null, contactId: string | null) => void;
  /** Bump to open a reply-all to the latest message (rail "Reply by email"). */
  replyRequest?: number;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [composer, setComposer] = useState<{ mode: ComposerMode; email: Email } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/crm/inbox/threads/${threadId}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? "Couldn't load the thread"); return; }
    setErr(null);
    setD(j);
    onContext?.(j.thread.company_id, j.thread.contact_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => { setD(null); setComposer(null); setOpen({}); void load(); }, [load]);

  const latest = d?.emails[d.emails.length - 1] ?? null;
  useEffect(() => {
    if (replyRequest && latest) setComposer({ mode: "replyAll", email: latest });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyRequest]);
  useEffect(() => { if (composer) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [composer]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    const res = await fetch(`/api/crm/inbox/threads/${threadId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j.error ?? "Couldn't save"); return false; }
    await load();
    onChanged?.();
    return true;
  }

  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    const res = await fetch(`/api/crm/inbox/threads/${threadId}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: note }) });
    setBusy(false);
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? "Couldn't save the note"); return; }
    setNote("");
    await load();
  }

  const items = useMemo(() => {
    if (!d) return [];
    const all: ({ kind: "email"; at: string; e: Email } | { kind: "note"; at: string; n: Note })[] = [
      ...d.emails.map((e) => ({ kind: "email" as const, at: e.received_at, e })),
      ...d.notes.map((n) => ({ kind: "note" as const, at: n.occurred_at, n })),
    ];
    return all.sort((a, b) => a.at.localeCompare(b.at));
  }, [d]);

  if (err && !d) return <p style={{ padding: 16, color: "var(--error)", fontSize: 13 }}>{err}</p>;
  if (!d) return <p style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>Loading…</p>;
  const t = d.thread;
  const self = t.mailbox?.address ?? "";

  function startComposer(mode: ComposerMode, e: Email) {
    setComposer({ mode, email: e });
  }
  function recipientsFor(mode: ComposerMode, e: Email): { to: ComposerRecipient[]; cc: ComposerRecipient[] } {
    if (mode === "forward") return { to: [], cc: [] };
    const sender = e.direction === "inbound" && e.from_email ? [{ email: e.from_email, name: e.from_name }] : e.to;
    if (mode === "reply") return { to: sender, cc: [] };
    const others = [...(e.direction === "inbound" ? e.to : []), ...e.cc].filter((a) => a.email !== self && !sender.some((s) => s.email === a.email));
    return { to: sender, cc: others };
  }
  const prefix = (mode: ComposerMode, s: string | null) => {
    const base = (s ?? "").replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "");
    return `${mode === "forward" ? "FW" : "RE"}: ${base}`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, color: "var(--navy)", wordBreak: "break-word" }}>{displaySubject(t.subject) || "(no subject)"}</h2>
            <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
              {mailboxLabel(t.mailbox)}{t.internal ? " · internal" : ""} · {d.emails.length} message{d.emails.length === 1 ? "" : "s"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {t.status !== "waiting_on_dealer" && <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => patch({ status: "waiting_on_dealer" })}>Waiting</button>}
            {t.status !== "closed"
              ? <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => patch({ status: "closed" })}>Close</button>
              : <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => patch({ status: "open" })}>Reopen</button>}
            <button type="button" className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} disabled={busy} onClick={() => patch({ unread: true })}>Mark unread</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", fontSize: 13 }}>
          <div>
            <p className="label">Status</p>
            <span style={{ fontWeight: 600 }}>{STATUS_LABEL[t.status]}</span>
          </div>
          <div>
            <p className="label">Assigned to</p>
            <div style={{ display: "flex", gap: 6 }}>
              <select className="input" style={{ height: 30, minWidth: 160 }} value={t.assigned_staff_id ?? ""} disabled={busy}
                onChange={(e) => patch({ assigned_staff_id: e.target.value || null })}>
                <option value="">Nobody</option>
                {d.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {t.assigned_staff_id !== meId && <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} disabled={busy} onClick={() => patch({ assigned_staff_id: meId })}>Me</button>}
            </div>
          </div>
          <LinkCompany thread={t} latest={latest} self={self} busy={busy} onPatch={patch} onError={setErr} />
        </div>
        {err && <p style={{ margin: 0, fontSize: 12, color: "var(--error)" }}>{err}</p>}
      </div>

      <div style={{ flex: 1 }}>
        {items.map((it) => it.kind === "note" ? (
          <div key={it.n.id} style={{ margin: "10px 16px", padding: "10px 14px", background: "var(--crm-warn-soft, #fff8e1)", border: "1px solid #f1dfbf", borderRadius: 10, fontSize: 13 }}>
            <div style={{ fontSize: 11, color: "#7a4d0b", marginBottom: 2 }}>Internal note · {it.n.author ?? "Staff"} · {when(it.n.occurred_at)}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{it.n.body}</div>
          </div>
        ) : (
          <MessageCard key={it.e.id} e={it.e} expanded={!!open[it.e.id] || it.e.id === latest?.id}
            onToggle={() => setOpen({ ...open, [it.e.id]: !open[it.e.id] })}
            onAction={(mode) => startComposer(mode, it.e)} />
        ))}
      </div>

      {composer && (() => {
        const r = recipientsFor(composer.mode, composer.email);
        return (
          <EmailComposer key={`${composer.mode}-${composer.email.id}`} mode={composer.mode} emailId={composer.email.id}
            companyId={t.company_id} contactId={t.contact_id} initialTo={r.to} initialCc={r.cc}
            initialSubject={prefix(composer.mode, composer.email.subject ?? t.subject)}
            onCancel={() => setComposer(null)}
            onSent={async () => { setComposer(null); await load(); onChanged?.(); }} />
        );
      })()}
      {!composer && latest && (
        <div style={{ padding: "10px 16px", display: "flex", gap: 8, borderTop: "1px solid var(--border)" }}>
          <button type="button" className="btn btn-primary" onClick={() => startComposer("reply", latest)}>Reply</button>
          <button type="button" className="btn btn-secondary" onClick={() => startComposer("replyAll", latest)}>Reply all</button>
          <button type="button" className="btn btn-secondary" onClick={() => startComposer("forward", latest)}>Forward</button>
        </div>
      )}
      <div style={{ padding: "10px 16px 16px", borderTop: "1px solid var(--border)" }}>
        <textarea className="input" style={{ height: 60, padding: "8px 12px", resize: "vertical" }} placeholder="Internal note (never emailed)…"
          value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 6, height: 28, fontSize: 12 }} disabled={busy || !note.trim()} onClick={addNote}>Add internal note</button>
      </div>
      <div ref={endRef} />
    </div>
  );
}

function MessageCard({ e, expanded, onToggle, onAction }: { e: Email; expanded: boolean; onToggle: () => void; onAction: (m: ComposerMode) => void }) {
  return (
    <div style={{ margin: "10px 16px", border: "1px solid var(--border)", borderRadius: 10, background: "#fff", borderLeft: `3px solid ${e.direction === "outbound" ? "var(--crm-accent, var(--blue))" : "var(--crm-border-strong, var(--orange))"}` }}>
      <button type="button" onClick={onToggle}
        style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: "8px 12px", cursor: "pointer", fontFamily: "inherit", display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ minWidth: 0, overflow: "hidden" }}>
          <strong style={{ fontSize: 13 }}>{who({ email: e.from_email, name: e.from_name })}</strong>
          {e.sent_by_name && <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · sent by {e.sent_by_name}</span>}
          {e.is_reply_all && <span style={{ fontSize: 11, color: "var(--text-muted)" }}> · reply all</span>}
          {!expanded && <span style={{ display: "block", fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{(e.text ?? "").slice(0, 160)}</span>}
        </span>
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{e.attachments.length > 0 && "📎 "}{when(e.received_at)}</span>
      </button>
      {expanded && (
        <div style={{ padding: "0 12px 10px" }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8, display: "grid", gap: 1 }}>
            <span>To: {list(e.to) || "—"}</span>
            {e.cc.length > 0 && <span>Cc: {list(e.cc)}</span>}
            {e.bcc.length > 0 && <span>Bcc: {list(e.bcc)}</span>}
          </div>
          <MessageFrame html={e.html} />
          {e.attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {e.attachments.map((a) => a.available ? (
                <a key={a.id} href={`/api/crm/inbox/attachments/${a.id}`} target="_blank" rel="noreferrer"
                  style={{ fontSize: 12, color: "var(--blue)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px", textDecoration: "none" }}>
                  {a.filename}{a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : ""}
                </a>
              ) : (
                <span key={a.id} title="Too large to copy — open it in Outlook" style={{ fontSize: 12, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 8px" }}>{a.filename} (in Outlook)</span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            {(["reply", "replyAll", "forward"] as const).map((m) => (
              <button key={m} type="button" onClick={() => onAction(m)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12, padding: 0 }}>
                {m === "reply" ? "Reply" : m === "replyAll" ? "Reply all" : "Forward"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Sandboxed (no scripts) and sized to its content. */
function MessageFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [h, setH] = useState(120);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.body) setH(Math.min(4000, Math.max(60, doc.documentElement.scrollHeight + 4)));
  };
  return (
    <iframe ref={ref} title="Email" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={html} onLoad={() => { fit(); setTimeout(fit, 400); }}
      style={{ width: "100%", height: h, border: "none", background: "#fff" }} />
  );
}

/** Linked company / contact, or the controls to link them (Unassigned threads). */
function LinkCompany({ thread: t, latest, self, busy, onPatch, onError }: {
  thread: Thread; latest: Email | null; self: string; busy: boolean;
  onPatch: (b: Record<string, unknown>) => Promise<boolean>; onError: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; kind: string; dealer_text_id: string | null }[]>([]);
  const [contacts, setContacts] = useState<{ id: string; first_name: string | null; last_name: string | null; email: string | null }[]>([]);

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(async () => {
      const j = await fetch(`/api/crm/companies/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.json()).catch(() => ({}));
      setHits(j.companies ?? []);
    }, 250);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => {
    if (!t.company_id) { setContacts([]); return; }
    fetch(`/api/crm/companies/search?contacts_for=${t.company_id}`).then((r) => r.json()).then((j) => setContacts(j.contacts ?? [])).catch(() => setContacts([]));
  }, [t.company_id]);

  // The external person on the latest message — "create contact" target.
  const person = latest ? (latest.direction === "inbound" ? { email: latest.from_email, name: latest.from_name } : { email: latest.to[0]?.email ?? null, name: latest.to[0]?.name ?? null }) : null;
  const canCreate = !!(t.company_id && !t.contact_id && person?.email && person.email !== self && !contacts.some((c) => (c.email ?? "").toLowerCase() === person.email));

  async function createContact() {
    if (!person?.email || !t.company_id) return;
    const [first, ...rest] = (person.name ?? person.email.split("@")[0]).replace(/[<>"(),;:@[\]]/g, " ").trim().split(/\s+/);
    const res = await fetch("/api/crm/contacts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_id: t.company_id, first_name: first || person.email, last_name: rest.join(" ") || null, email: person.email }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { onError(j.error ?? "Couldn't create the contact"); return; }
    await onPatch({ contact_id: j.id ?? j.contact?.id });
  }

  if (t.company_id && !editing) {
    return (
      <>
        <div>
          <p className="label">Company</p>
          <span style={{ display: "flex", gap: 8, alignItems: "center", height: 30 }}>
            <a href={`/crm/companies/${t.company_id}`} style={{ color: "var(--blue)", fontWeight: 600 }}>{t.company_name ?? "Company"}</a>
            <button type="button" onClick={() => setEditing(true)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12 }}>Change</button>
          </span>
        </div>
        <div>
          <p className="label">Contact</p>
          <div style={{ display: "flex", gap: 6 }}>
            <select className="input" style={{ height: 30, minWidth: 160 }} value={t.contact_id ?? ""} disabled={busy} onChange={(e) => onPatch({ contact_id: e.target.value || null })}>
              <option value="">—</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}</option>)}
            </select>
            {canCreate && <button type="button" className="btn btn-secondary" style={{ height: 30, fontSize: 12 }} disabled={busy} onClick={createContact}>Create contact: {person!.email}</button>}
          </div>
        </div>
      </>
    );
  }
  return (
    <div style={{ flex: 1, minWidth: 240 }}>
      <p className="label">{t.company_id ? "Link to a different company" : "Link a company"}</p>
      {!t.company_id && t.candidates.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
          {t.candidates.map((c) => (
            <button key={c.id} type="button" className="btn btn-secondary" style={{ height: 26, fontSize: 12 }} disabled={busy} onClick={() => onPatch({ company_id: c.id })}>{c.name}</button>
          ))}
        </div>
      )}
      <div style={{ position: "relative" }}>
        <input className="input" style={{ height: 30 }} placeholder="Search dealers, groups, partners…" value={q} onChange={(e) => setQ(e.target.value)} />
        {hits.length > 0 && (
          <div className="card" style={{ position: "absolute", zIndex: 20, left: 0, right: 0, top: 32, maxHeight: 240, overflowY: "auto", padding: 4 }}>
            {hits.map((h) => (
              <button key={h.id} type="button" disabled={busy} onClick={async () => { if (await onPatch({ company_id: h.id })) { setEditing(false); setQ(""); } }}
                style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "6px 8px", cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}>
                {h.name} <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{h.kind}{h.dealer_text_id ? ` · ${h.dealer_text_id}` : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {editing && <button type="button" onClick={() => setEditing(false)} style={{ background: "none", border: "none", color: "var(--blue)", cursor: "pointer", fontSize: 12, marginTop: 4 }}>Cancel</button>}
    </div>
  );
}
