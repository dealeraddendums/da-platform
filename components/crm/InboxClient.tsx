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
        <div className="card" style={{ padding: "10px 14px", marginBottom: 12, fontSize: 13, background: "#fff8e1", border: "1px solid #ffe082", color: "#7a5c00" }}>
          The mailboxes haven&apos;t synced yet. Microsoft 365 needs the Azure app registration and access policy (CLAUDE.md → DA-CRM → Azure app registration runbook), then the first backfill.
        </div>
      )}
      {!neverSynced && errors.length > 0 && (
        <div className="card" style={{ padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "var(--error)" }}>
          {errors.map((m) => <div key={m.id}>{m.address}: {m.last_error}</div>)}
        </div>
      )}

      <div className="card" style={{ padding: "10px 12px", marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" onClick={() => { setView(k); setPage(0); }}
              style={{
                height: 30, padding: "0 12px", borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                border: `1px solid ${view === k ? "var(--blue)" : "var(--border)"}`, background: view === k ? "var(--blue)" : "#fff", color: view === k ? "#fff" : "var(--text-primary)",
              }}>
              {label}{data?.counts?.[k] != null && <span style={{ opacity: 0.75, marginLeft: 6 }}>{data.counts[k]}</span>}
            </button>
          ))}
        </div>
        <select className="input" style={{ width: 230, height: 30 }} value={mailbox} onChange={(e) => { setMailbox(e.target.value); setPage(0); }}>
          <option value="">All mailboxes</option>
          {mbs.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
        </select>
        <input className="input" style={{ width: 240, height: 30 }} placeholder="Search subject or address…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn btn-primary" style={{ marginLeft: "auto", height: 30 }} onClick={() => setComposeOpen(true)}>New email</button>
      </div>

      <div className="crm-inbox-grid">
        <div className="card crm-inbox-pane" style={{ padding: 0 }}>
          {err && <p style={{ padding: 12, margin: 0, color: "var(--error)", fontSize: 13 }}>{err}</p>}
          {data && !data.threads.length && <p style={{ padding: 16, margin: 0, color: "var(--text-muted)", fontSize: 13 }}>Nothing here.</p>}
          {data?.threads.map((t) => (
            <button key={t.id} type="button" onClick={() => setSelected(t.id)}
              style={{
                display: "block", width: "100%", textAlign: "left", border: "none", borderBottom: "1px solid var(--border)", padding: "10px 12px", cursor: "pointer", fontFamily: "inherit",
                background: selected === t.id ? "#e3f2fd" : "#fff", borderLeft: `3px solid ${selected === t.id ? "var(--blue)" : t.unread ? "var(--orange)" : "transparent"}`,
              }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: t.unread ? 700 : 600, color: "var(--navy)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.company_name ?? t.last_from_name ?? t.last_from_email ?? "Unknown"}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtAgo(t.last_message_at)}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: t.unread ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.subject || "(no subject)"}{t.message_count > 1 && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> ({t.message_count})</span>}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.last_snippet}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
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
            ? <CompanyContextRail companyId={ctx.companyId} contactId={ctx.contactId} meId={meId} refreshKey={railTick}
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
        .crm-inbox-grid { display: grid; grid-template-columns: 340px minmax(0, 1fr) 300px; gap: 12px; align-items: start; }
        .crm-inbox-pane { height: calc(100vh - 230px); min-height: 480px; overflow-y: auto; }
        @media (max-width: 1280px) { .crm-inbox-grid { grid-template-columns: 300px minmax(0, 1fr); } .crm-inbox-rail { grid-column: 1 / -1; height: auto; } }
        @media (max-width: 860px) { .crm-inbox-grid { grid-template-columns: 1fr; } .crm-inbox-pane { height: auto; max-height: none; } }
      `}</style>
    </div>
  );
}

function Chip({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 6px", borderRadius: 3, background: warn ? "#fff3e0" : "var(--bg-subtle)", color: warn ? "#b26a00" : "var(--text-secondary)" }}>{children}</span>
  );
}
