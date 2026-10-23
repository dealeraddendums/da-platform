"use client";

// The DA-CRM Inbox: thread list | conversation (ThreadView) | CompanyContextRail.
// Views: Unassigned, Mine, Open, Waiting, Closed, All; a mailbox filter and
// search. Selecting a thread keeps you on this screen (the URL updates so the
// view can be shared); new email opens in a slide-over.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ThreadView, { STATUS_LABEL } from "./ThreadView";
import CompanyContextRail from "./CompanyContextRail";
import SlideOver from "./SlideOver";
import EmailComposer from "./EmailComposer";
import { fmtAgo } from "@/lib/crm/format";

type ThreadRow = {
  id: string; mailbox: string | null; subject: string | null; status: string; unread: boolean; internal: boolean;
  last_message_at: string | null; last_direction: string | null; last_from_email: string | null; last_from_name: string | null;
  last_snippet: string | null; message_count: number; company_name: string | null; contact_name: string | null; assigned_name: string | null;
  match_candidates: string[];
};
type Mailbox = { id: string; address: string; display_name: string; purpose: string; active: boolean; last_synced_at: string | null; last_error: string | null };
type ListResp = { threads: ThreadRow[]; counts: Record<string, number>; mailboxes: Mailbox[]; total: number; page: number; pageSize: number };

const VIEWS: [string, string][] = [["unassigned", "Unassigned"], ["mine", "Mine"], ["open", "Open"], ["waiting", "Waiting"], ["closed", "Closed"], ["all", "All"]];

export default function InboxClient({ meId, initial }: { meId: string; initial: { view: string; mailbox: string; thread: string | null; q: string } }) {
  const router = useRouter();
  const [view, setView] = useState(VIEWS.some(([k]) => k === initial.view) ? initial.view : "open");
  const [mailbox, setMailbox] = useState(initial.mailbox);
  const [q, setQ] = useState(initial.q);
  const [term, setTerm] = useState(initial.q);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initial.thread);
  const [ctx, setCtx] = useState<{ companyId: string | null; contactId: string | null }>({ companyId: null, contactId: null });
  const [replyTick, setReplyTick] = useState(0);
  const [railTick, setRailTick] = useState(0);
  const [composeOpen, setComposeOpen] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ view, page: String(page) });
    if (mailbox) qs.set("mailbox", mailbox);
    if (term.trim()) qs.set("q", term.trim());
    const res = await fetch(`/api/crm/inbox/threads?${qs}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j.error ?? "Couldn't load the inbox"); return; }
    setErr(null);
    setData(j);
  }, [view, mailbox, term, page]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const id = setInterval(() => { void load(); }, 60_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setTimeout(() => { setTerm(q); setPage(0); }, 300); return () => clearTimeout(id); }, [q]);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (view !== "open") qs.set("view", view);
    if (mailbox) qs.set("mailbox", mailbox);
    if (term.trim()) qs.set("q", term.trim());
    if (selected) qs.set("thread", selected);
    router.replace(`/crm/communications/inbox${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
  }, [view, mailbox, term, selected, router]);

  const onContext = useCallback((companyId: string | null, contactId: string | null) => setCtx({ companyId, contactId }), []);
  const onChanged = useCallback(() => { void load(); setRailTick((n) => n + 1); }, [load]);

  const mbs = data?.mailboxes ?? [];
  const neverSynced = mbs.length > 0 && mbs.every((m) => !m.last_synced_at);
  const errors = mbs.filter((m) => m.active && m.last_error);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      {neverSynced && (
        <div className="crm-notice" style={{ marginBottom: 12 }}>
          The mailboxes haven&apos;t synced yet. Microsoft 365 needs the Azure app registration and access policy (CLAUDE.md → DA-CRM → Azure app registration runbook), then the first backfill.
        </div>
      )}
      {!neverSynced && errors.length > 0 && (
        <div className="crm-notice danger" style={{ marginBottom: 12, wordBreak: "break-word" }}>
          {errors.map((m) => <div key={m.id}>{m.address}: {m.last_error}</div>)}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, margin: "4px 0 20px" }}>
        <div>
          <h1 className="crm-h1">Inbox</h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--crm-muted)" }}>support@ and feeds@ — reply from here and it goes out from the mailbox, threaded in Outlook.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setComposeOpen(true)}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          New email
        </button>
      </div>

      <div style={{ marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div className="crm-tabs" role="tablist" aria-label="Inbox views">
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className="crm-tab" onClick={() => { setView(k); setPage(0); }}>
              {label}{data?.counts?.[k] != null && <span className="crm-count">{data.counts[k]}</span>}
            </button>
          ))}
        </div>
        <select className="input" style={{ width: 230, height: 36, marginLeft: "auto" }} value={mailbox} onChange={(e) => { setMailbox(e.target.value); setPage(0); }}>
          <option value="">All mailboxes</option>
          {mbs.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
        </select>
        <input className="input" style={{ width: 260, height: 36 }} placeholder="Search subject or address…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="crm-inbox-grid">
        <div className="card crm-inbox-pane" style={{ padding: 0 }}>
          {err && <p style={{ padding: 12, margin: 0, color: "var(--error)", fontSize: 13 }}>{err}</p>}
          {data && !data.threads.length && <p style={{ padding: 16, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Nothing here.</p>}
          {data?.threads.map((t) => (
            <button key={t.id} type="button" onClick={() => setSelected(t.id)}
              className={`crm-row${t.unread ? " unread" : ""}`} aria-current={selected === t.id}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13.5, fontWeight: t.unread ? 700 : 600, color: "var(--crm-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.company_name ?? t.last_from_name ?? t.last_from_email ?? "Unknown"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtAgo(t.last_message_at)}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: t.unread ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.subject || "(no subject)"}{t.message_count > 1 && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> ({t.message_count})</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.last_snippet}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <Chip>{STATUS_LABEL[t.status] ?? t.status}</Chip>
                {!mailbox && t.mailbox && <Chip>{t.mailbox.split("@")[0]}@</Chip>}
                {!t.company_name && !t.internal && <Chip warn>{t.match_candidates?.length ? "Pick company" : "Unassigned"}</Chip>}
                {t.internal && <Chip>Internal</Chip>}
                {t.assigned_name && <Chip>{t.assigned_name}</Chip>}
              </div>
            </button>
          ))}
          {data && pages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", fontSize: 12 }}>
              <button type="button" className="btn btn-secondary" style={{ height: 26, fontSize: 12 }} disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</button>
              <span style={{ color: "var(--text-muted)" }}>Page {page + 1} of {pages}</span>
              <button type="button" className="btn btn-secondary" style={{ height: 26, fontSize: 12 }} disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Older</button>
            </div>
          )}
        </div>

        <div className="card crm-inbox-pane" style={{ padding: 0 }}>
          {selected
            ? <ThreadView threadId={selected} meId={meId} onChanged={onChanged} onContext={onContext} replyRequest={replyTick} />
            : <p style={{ padding: 16, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Pick a conversation.</p>}
        </div>

        <div className="card crm-inbox-pane crm-inbox-rail" style={{ padding: 0 }}>
          {selected
            ? <CompanyContextRail companyId={ctx.companyId} contactId={ctx.contactId} meId={meId} refreshKey={railTick} threadId={selected}
                onReplyEmail={() => setReplyTick((n) => n + 1)} onOpenThread={(id) => setSelected(id)} />
            : <p style={{ padding: 14, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Company details show here.</p>}
        </div>
      </div>

      <SlideOver open={composeOpen} title="New email" onClose={() => setComposeOpen(false)} width={760}>
        {composeOpen && (
          <EmailComposer mode="new" mailboxes={mbs.filter((m) => m.active)}
            defaultMailboxId={(mailbox && mbs.find((m) => m.id === mailbox)?.id) || mbs.find((m) => m.purpose === "support")?.id}
            onCancel={() => setComposeOpen(false)}
            onSent={(r) => { setComposeOpen(false); void load(); if (r.thread_id) setSelected(r.thread_id); }} />
        )}
      </SlideOver>

      <style>{`
        .crm-inbox-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr) 300px; gap: 16px; align-items: start; }
        .crm-inbox-pane { height: calc(100vh - 250px); min-height: 480px; overflow-y: auto; }
        @media (max-width: 1280px) { .crm-inbox-grid { grid-template-columns: 300px minmax(0, 1fr); } .crm-inbox-rail { grid-column: 1 / -1; height: auto; } }
        @media (max-width: 860px) { .crm-inbox-grid { grid-template-columns: 1fr; } .crm-inbox-pane { height: auto; max-height: none; } }
      `}</style>
    </div>
  );
}

function Chip({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 500, padding: "2px 8px", borderRadius: 999, background: warn ? "var(--crm-warn-soft)" : "var(--crm-surface-2)", color: warn ? "#8a5a10" : "var(--crm-ink-2)" }}>{children}</span>
  );
}
