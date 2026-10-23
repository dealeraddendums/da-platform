"use client";

// CompanyContextRail — the right-hand rail of every DA-CRM conversation view
// (Inbox thread, Steven chat, ticket, task). One component everywhere: who
// this is (company, contact, trial stage), what's open (tickets, tasks, feed
// orders), what happened lately (calls, email threads), and the actions block
// so staff finish the job without leaving the screen. Tickets, tasks and
// threads open as slide-overs on top of the current screen.
// Data: GET /api/crm/rail.

import { useCallback, useEffect, useRef, useState } from "react";
import ClickToCall from "./ClickToCall";
import SlideOver from "./SlideOver";
import EmailComposer from "./EmailComposer";
import ThreadView from "./ThreadView";
import FeedOrderForm from "./FeedOrderForm";
import FeedOrderPanel, { AGE_COLOR, StatusChip } from "./FeedOrderPanel";
import { KIND_LABEL, STAGES, STAGE_LABEL, fmtAgo, fmtDate, formatDuration, type Stage } from "@/lib/crm/format";

type Rail = {
  company: null | {
    id: string; kind: string; name: string; dealer_text_id: string | null; city: string | null; state: string | null; phone: string | null;
    account_type: string | null; active: boolean; pipeline_stage: Stage | null; trial_day: number | null; trial_ends_on: string | null;
    trial_flag: string | null; owner_name: string | null; website: string | null; emails: { address: string }[];
  };
  contact: null | { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null };
  contacts?: { id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }[];
  tickets?: { id: string; title: string; status: string; assigned_name: string | null; created_at: string }[];
  tasks?: { id: string; title: string; status: string; assigned_name: string | null; created_at: string }[];
  calls?: { id: string; direction: string; started_at: string | null; duration_sec: number | null; state: string; summary: string | null; staff_name: string | null }[];
  threads?: { id: string; subject: string | null; status: string; last_message_at: string | null; unread: boolean }[];
  feedOrders?: { id: string; number: string; status: string; status_label: string; age_days: number; age_color: string; next_action: string; supplier_name: string | null; feed_id_candidate: string | null; dealer_name: string | null; dealerships: { id: string }[] }[];
  canDial: boolean;
};

type Panel =
  | { kind: "compose" }
  | { kind: "thread"; id: string }
  | { kind: "ticket"; item?: { title: string; status: string } }
  | { kind: "task"; item?: { title: string; status: string } }
  | { kind: "feed" }
  | { kind: "order"; id: string }
  | null;

const H: React.CSSProperties = { margin: "0 0 6px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 };
const SEC: React.CSSProperties = { padding: "12px 14px", borderBottom: "1px solid var(--border)" };
const name = (c: { first_name: string | null; last_name: string | null; email: string | null }) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "Contact";

export default function CompanyContextRail({
  companyId, contactId, meId, onReplyEmail, onOpenThread, refreshKey, threadId,
}: {
  companyId: string | null;
  contactId?: string | null;
  meId: string;
  /** Inbox: reply on the open thread. Elsewhere the rail opens a new-email slide-over. */
  onReplyEmail?: () => void;
  /** Inbox: select the thread in the list. Elsewhere it opens in a slide-over. */
  onOpenThread?: (id: string) => void;
  refreshKey?: number;
  /** The conversation this rail sits beside (feed orders started here link to it). */
  threadId?: string | null;
}) {
  const [d, setD] = useState<Rail | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (companyId) qs.set("company_id", companyId);
    if (contactId) qs.set("contact_id", contactId);
    const j = await fetch(`/api/crm/rail?${qs}`).then((r) => r.json()).catch(() => null);
    setD(j);
  }, [companyId, contactId]);
  useEffect(() => { setMsg(null); void load(); }, [load, refreshKey]);

  const co = d?.company ?? null;
  const ct = d?.contact ?? null;

  async function saveNote() {
    if (!note.trim() || !co) return;
    setBusy(true);
    const res = await fetch("/api/crm/activities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company_id: co.id, contact_id: ct?.id, body: note }) });
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: (await res.json().catch(() => ({}))).error ?? "Couldn't save the note" }); return; }
    setNote(""); setNoteOpen(false); setMsg({ ok: true, text: "Note added to the timeline." });
  }
  async function attach(file: File) {
    if (!co) return;
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/crm/companies/${co.id}/files`, { method: "POST", body: form });
    setBusy(false);
    setMsg(res.ok ? { ok: true, text: `${file.name} attached to ${co.name}.` } : { ok: false, text: (await res.json().catch(() => ({}))).error ?? "Upload failed" });
  }
  async function setStage(stage: string) {
    if (!co) return;
    setBusy(true);
    const res = await fetch(`/api/crm/companies/${co.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pipeline_stage: stage }) });
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: (await res.json().catch(() => ({}))).error ?? "Couldn't change the stage" }); return; }
    setMsg({ ok: true, text: `Stage set to ${STAGE_LABEL[stage as Stage]}.` });
    await load();
  }

  if (!d) return <aside style={{ padding: 14, fontSize: 13, color: "var(--text-muted)" }}>Loading…</aside>;

  const phone = ct?.phone ?? co?.phone ?? null;
  const emailTo = ct?.email ? [{ email: ct.email, name: name(ct) }] : co?.emails?.[0]?.address ? [{ email: co.emails[0].address }] : [];

  return (
    <aside style={{ fontSize: 13, background: "#fff" }}>
      {/* ── Who ─────────────────────────────────────────────────────────── */}
      <div style={SEC}>
        {co ? (
          <>
            <a href={`/crm/companies/${co.id}`} style={{ fontSize: 15, fontWeight: 700, color: "var(--navy)", textDecoration: "none" }}>{co.name}</a>
            <p style={{ margin: "2px 0 0", color: "var(--text-muted)", fontSize: 12 }}>
              {[KIND_LABEL[co.kind], co.dealer_text_id, [co.city, co.state].filter(Boolean).join(", "), co.account_type, co.active ? null : "Inactive"].filter(Boolean).join(" · ")}
            </p>
            <p style={{ margin: "6px 0 0", fontSize: 12 }}>Owner: <strong>{co.owner_name ?? "Unassigned"}</strong></p>
            {co.website && <p style={{ margin: "2px 0 0", fontSize: 12 }}><a href={/^https?:\/\//.test(co.website) ? co.website : `https://${co.website}`} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>{co.website.replace(/^https?:\/\//, "")}</a></p>}
          </>
        ) : (
          <p style={{ margin: 0, color: "var(--text-muted)" }}>Not linked to a company yet. Link one from the conversation header.</p>
        )}
      </div>

      {ct && (
        <div style={SEC}>
          <p style={H}>Contact</p>
          <a href={`/crm/contacts/${ct.id}`} style={{ fontWeight: 600, color: "var(--blue)" }}>{name(ct)}</a>
          {ct.title && <span style={{ color: "var(--text-muted)" }}> · {ct.title}</span>}
          {ct.email && <p style={{ margin: "2px 0 0", fontSize: 12 }}>{ct.email}</p>}
        </div>
      )}

      {co?.kind === "dealer" && (
        <div style={SEC}>
          <p style={H}>Trial stage</p>
          <select className="input" style={{ height: 30 }} value={co.pipeline_stage ?? ""} disabled={busy} onChange={(e) => setStage(e.target.value)}>
            {!co.pipeline_stage && <option value="">—</option>}
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          {co.pipeline_stage === "trial" && (
            <p style={{ margin: "4px 0 0", fontSize: 12, color: co.trial_flag ? "var(--error)" : "var(--text-secondary)" }}>
              Day {co.trial_day ?? "—"}{co.trial_ends_on ? ` · ends ${fmtDate(co.trial_ends_on)}` : ""}{co.trial_flag === "expired" ? " · expired" : ""}
            </p>
          )}
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <div style={SEC}>
        <p style={H}>Actions</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <Act onClick={() => (onReplyEmail ? onReplyEmail() : setPanel({ kind: "compose" }))} disabled={!onReplyEmail && !co}>{onReplyEmail ? "Reply by email" : "Email"}</Act>
          <Act disabled title="Steven chat replies arrive in phase 3">Reply in chat</Act>
          <Act onClick={() => setPanel({ kind: "ticket" })} disabled={!co}>Create ticket</Act>
          <Act onClick={() => setPanel({ kind: "task" })} disabled={!co}>Create task</Act>
          <Act onClick={() => setNoteOpen(!noteOpen)} disabled={!co}>Add note</Act>
          <Act onClick={() => fileRef.current?.click()} disabled={!co || busy}>Attach file</Act>
          <Act onClick={() => setPanel({ kind: "feed" })} disabled={co?.kind !== "dealer" && co?.kind !== "group"}>Start feed order</Act>
        </div>
        <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void attach(f); }} />
        {phone && <div style={{ marginTop: 8 }}><ClickToCall phone={phone} canDial={d.canDial} /></div>}
        {noteOpen && (
          <div style={{ marginTop: 8 }}>
            <textarea className="input" style={{ height: 64, padding: "6px 10px", resize: "vertical" }} placeholder="Note for the timeline…" value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn-primary" style={{ height: 28, fontSize: 12, marginTop: 4 }} disabled={busy || !note.trim()} onClick={saveNote}>Save note</button>
          </div>
        )}
        {msg && <p style={{ margin: "6px 0 0", fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</p>}
      </div>

      {co && (
        <>
          <ListSection title="Open tickets" empty="No open tickets.">
            {(d.tickets ?? []).map((t) => <Row key={t.id} onClick={() => setPanel({ kind: "ticket", item: t })} main={t.title} sub={`${t.status} · ${t.assigned_name ?? "unassigned"}`} />)}
          </ListSection>
          <ListSection title="Open tasks" empty="No open tasks.">
            {(d.tasks ?? []).map((t) => <Row key={t.id} onClick={() => setPanel({ kind: "task", item: t })} main={t.title} sub={t.assigned_name ?? "unassigned"} />)}
          </ListSection>
          {(co.kind === "dealer" || co.kind === "group") && (
            <ListSection title="Feed orders" empty="No feed orders.">
              {(d.feedOrders ?? []).map((o) => (
                <div key={o.id} style={{ padding: "6px 0", borderBottom: "1px dashed var(--border)" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <StatusChip status={o.status} label={o.status_label} />
                    {!["done", "cancelled"].includes(o.status) && <span style={{ fontSize: 11, color: AGE_COLOR[o.age_color] }}>● {o.age_days} bd</span>}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 3 }}>{o.supplier_name ?? "Supplier not known"} · {o.number}</div>
                  {o.dealerships.length > 1 && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{o.dealer_name}</div>}
                  {!["done", "cancelled"].includes(o.status) && <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Next: {o.next_action}{o.status === "feed_id_received" && o.feed_id_candidate ? ` (${o.feed_id_candidate})` : ""}</div>}
                  <button type="button" className={`btn ${["ready", "feed_id_received"].includes(o.status) ? "btn-primary" : "btn-secondary"}`} style={{ height: 26, fontSize: 12, marginTop: 4, background: ["ready", "feed_id_received"].includes(o.status) ? undefined : "#fff" }}
                    onClick={() => setPanel({ kind: "order", id: o.id })}>
                    {o.status === "ready" ? "Review & send request" : o.status === "feed_id_received" ? "Confirm Feed ID" : "Open order"}
                  </button>
                </div>
              ))}
            </ListSection>
          )}
          <ListSection title="Recent calls" empty="No calls yet.">
            {(d.calls ?? []).map((c) => (
              <Row key={c.id} main={`${c.direction === "inbound" ? "Inbound" : "Outbound"} · ${c.state === "completed" ? formatDuration(c.duration_sec) : c.state}`}
                sub={`${fmtAgo(c.started_at)}${c.staff_name ? ` · ${c.staff_name}` : ""}${c.summary ? ` · ${c.summary.slice(0, 80)}` : ""}`} />
            ))}
          </ListSection>
          <ListSection title="Recent emails" empty="No email threads.">
            {(d.threads ?? []).map((t) => (
              <Row key={t.id} onClick={() => (onOpenThread ? onOpenThread(t.id) : setPanel({ kind: "thread", id: t.id }))}
                main={<>{t.unread && <span style={{ color: "var(--orange)" }}>● </span>}{t.subject || "(no subject)"}</>} sub={`${fmtAgo(t.last_message_at)} · ${t.status.replace(/_/g, " ")}`} />
            ))}
          </ListSection>
          {(d.contacts ?? []).length > 0 && (
            <ListSection title="Contacts" empty="">
              {(d.contacts ?? []).slice(0, 8).map((c) => (
                <div key={c.id} style={{ padding: "4px 0" }}>
                  <a href={`/crm/contacts/${c.id}`} style={{ color: "var(--blue)" }}>{name(c)}</a>
                  {c.phone && <div style={{ marginTop: 2 }}><ClickToCall phone={c.phone} canDial={d.canDial} /></div>}
                </div>
              ))}
            </ListSection>
          )}
        </>
      )}

      {/* ── Slide-overs ─────────────────────────────────────────────────── */}
      <SlideOver open={panel?.kind === "compose"} title={`Email ${co?.name ?? ""}`} onClose={() => setPanel(null)} width={760}>
        {panel?.kind === "compose" && <ComposeNew companyId={co?.id ?? null} contactId={ct?.id ?? null} to={emailTo} onDone={() => { setPanel(null); setMsg({ ok: true, text: "Email sent." }); void load(); }} onCancel={() => setPanel(null)} />}
      </SlideOver>
      <SlideOver open={panel?.kind === "thread"} title="Email thread" onClose={() => setPanel(null)} width={820}>
        {panel?.kind === "thread" && <ThreadView threadId={panel.id} meId={meId} onChanged={load} />}
      </SlideOver>
      <SlideOver open={panel?.kind === "ticket" || panel?.kind === "task"} title={panel && "item" in panel && panel.item ? panel.item.title : panel?.kind === "task" ? "New task" : "New ticket"} onClose={() => setPanel(null)}>
        <Stub text={panel?.kind === "task" ? "Tasks arrive in phase 5. They will open here, on top of this screen, linked to this conversation." : "Tickets arrive in phase 4. They will open here, on top of this screen, linked to this conversation."} />
      </SlideOver>
      <SlideOver open={panel?.kind === "feed"} title="Start feed order" onClose={() => setPanel(null)}>
        {panel?.kind === "feed" && co && (
          <FeedOrderForm dealerCompanyId={co.id} dealerName={co.name} companyKind={co.kind === "group" ? "group" : "dealer"} emailThreadId={threadId ?? null} source={threadId ? "email" : "call"}
            defaultApprover={ct ? { name: name(ct), email: ct.email, phone: ct.phone } : undefined}
            onCancel={() => setPanel(null)}
            onCreated={(o, existed) => { setMsg({ ok: true, text: existed ? "This dealer already has an open feed order — opened it." : "Feed order started." }); setPanel({ kind: "order", id: o.id }); void load(); }} />
        )}
      </SlideOver>
      <SlideOver open={panel?.kind === "order"} title="Feed order" onClose={() => { setPanel(null); void load(); }} width={760}>
        {panel?.kind === "order" && <FeedOrderPanel orderId={panel.id} meId={meId} onChanged={load} />}
      </SlideOver>
    </aside>
  );
}

/** New email from a company / contact: loads the mailboxes, then the composer. */
export function ComposeNew({ companyId, contactId, to, onDone, onCancel }: { companyId: string | null; contactId: string | null; to: { email: string; name?: string }[]; onDone: () => void; onCancel: () => void }) {
  const [mbs, setMbs] = useState<{ id: string; address: string; display_name: string; purpose: string; active: boolean }[] | null>(null);
  useEffect(() => { fetch("/api/crm/inbox/threads?view=all&page=0").then((r) => r.json()).then((j) => setMbs((j.mailboxes ?? []).filter((m: { active: boolean }) => m.active))).catch(() => setMbs([])); }, []);
  if (!mbs) return <p style={{ padding: 16, color: "var(--text-muted)" }}>Loading…</p>;
  const def = mbs.find((m) => m.purpose === "support") ?? mbs[0];
  return <EmailComposer mode="new" mailboxes={mbs} defaultMailboxId={def?.id} companyId={companyId} contactId={contactId} initialTo={to} onSent={onDone} onCancel={onCancel} />;
}

function Act({ children, onClick, disabled, title }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="btn btn-secondary" onClick={onClick} disabled={disabled} title={title}
      style={{ height: 30, fontSize: 12, padding: "0 8px", justifyContent: "center", background: "#fff" }}>{children}</button>
  );
}

function ListSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const has = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <div style={SEC}>
      <p style={H}>{title}</p>
      {has ? children : <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{empty}</p>}
    </div>
  );
}

function Row({ main, sub, onClick }: { main: React.ReactNode; sub?: string; onClick?: () => void }) {
  const inner = (
    <>
      <span style={{ display: "block", fontSize: 13, color: onClick ? "var(--blue)" : "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{main}</span>
      {sub && <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sub}</span>}
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "4px 0", cursor: "pointer", fontFamily: "inherit" }}>{inner}</button>
    : <div style={{ padding: "4px 0" }}>{inner}</div>;
}

function Stub({ text }: { text: string }) {
  return <p style={{ padding: 16, margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>{text}</p>;
}
