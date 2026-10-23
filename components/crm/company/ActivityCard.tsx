"use client";

// Activity timeline (company and contact pages). Every activity is ONE compact row — type chip · title ·
// who · time — grouped under day headers, 25 at a time with Load more (never the whole history). Emails
// of one thread are one row (crm_timeline_rows): expanding lists its messages; expanding a message shows
// its new text, "Show quoted history" the rest; the title opens the thread in the Communications card.
// The note box sits on top as one line until clicked. A Summary source ("crm:activity-focus" { id })
// scrolls to its row, loading older pages until it's found.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AddNoteForm from "@/components/crm/AddNoteForm";
import { ActivityTypeBadge, CallStateBadge } from "@/components/crm/CrmBadges";
import { fmtAgo, fmtDateTime } from "@/lib/crm/format";

// Rows sit under a day header, so the time column shows the time of day (relative for today).
const rowTime = (iso: string) => {
  const d = new Date(iso);
  return Date.now() - d.getTime() < 12 * 3_600_000 ? fmtAgo(iso) : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
import { TIMELINE_FILTERS, dayLabel, oneLine, type TimelineFilter, type TimelineRow } from "@/lib/crm/timeline-rows";

type Cursor = { before: string; before_id: string } | null;
type Msg = { id: string; activity_id: string | null; direction: string; who: string | null; at: string; new_text: string; full_text: string };

export default function ActivityCard({ companyId, contactId, title = "Activity" }: { companyId?: string; contactId?: string; title?: string }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [next, setNext] = useState<Cursor>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);          // expanded row id
  const [flash, setFlash] = useState<string | null>(null);
  const pending = useRef<string | null>(null);                     // activity id a Summary source asked for

  const page = useCallback(async (f: TimelineFilter, cursor: Cursor) => {
    const qs = new URLSearchParams({ filter: f });
    if (companyId) qs.set("company_id", companyId); else if (contactId) qs.set("contact_id", contactId);
    if (cursor) { qs.set("before", cursor.before); qs.set("before_id", cursor.before_id); }
    const r = await fetch(`/api/crm/timeline?${qs}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "Couldn't load activity");
    return j as { rows: TimelineRow[]; next: Cursor };
  }, [companyId, contactId]);

  const reload = useCallback(async (f: TimelineFilter) => {
    setLoading(true); setErr(null);
    try { const j = await page(f, null); setRows(j.rows); setNext(j.next); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setLoading(false);
  }, [page]);
  useEffect(() => { void reload(filter); }, [filter, reload]);

  const more = useCallback(async () => {
    if (!next) return null;
    setLoading(true);
    try { const j = await page(filter, next); setRows((r) => [...r, ...j.rows]); setNext(j.next); setLoading(false); return j; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); return null; }
  }, [filter, next, page]);

  // Summary source → find the row (any of its activity ids), loading older pages as needed.
  const focus = useCallback((id: string) => {
    const hit = rows.find((r) => r.activityIds.includes(id));
    if (hit) {
      pending.current = null;
      if (hit.thread && hit.thread.count > 1) setOpen(hit.id);
      setFlash(hit.id);
      setTimeout(() => document.getElementById(`act-${hit.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 30);
      setTimeout(() => setFlash(null), 1800);
      return true;
    }
    return false;
  }, [rows]);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent).detail?.id as string | undefined;
      if (!id) return;
      if (filter !== "all") { pending.current = id; setFilter("all"); return; }
      if (!focus(id)) { pending.current = id; void more(); }
    };
    window.addEventListener("crm:activity-focus", on);
    return () => window.removeEventListener("crm:activity-focus", on);
  }, [filter, focus, more]);
  useEffect(() => {            // keep paging (≤ 10 pages) until a requested row shows up
    const id = pending.current;
    if (!id || loading) return;
    if (focus(id)) return;
    if (next && rows.length < 250) void more(); else pending.current = null;
  }, [rows, loading, next, focus, more]);

  let lastDay = "";
  return (
    <section className="crm-card">
      <div className="crm-card-head" style={{ flexWrap: "wrap" }}>
        <h2>{title}</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TIMELINE_FILTERS.map(([k, label]) => (
            <button key={k} type="button" className="crm-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
      </div>
      <AddNoteForm companyId={companyId} contactId={contactId} collapsible onSaved={() => void reload(filter)} />
      {err && <p className="crm-notice danger" style={{ margin: "0 16px 12px" }}>{err}</p>}
      {!loading && !rows.length && !err && <div className="crm-empty">{filter === "all" ? "No activity yet." : "Nothing of this kind yet."}</div>}
      <div className="crm-tl">
        {rows.map((r) => {
          const day = dayLabel(r.occurredAt);
          const header = day !== lastDay ? (lastDay = day, <div className="crm-tl-day" key={`d-${r.id}`}>{day}</div>) : null;
          return (
            <Fragment key={r.id}>
              {header}
              <Row r={r} open={open === r.id} flash={flash === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
            </Fragment>
          );
        })}
      </div>
      {(next || loading) && (
        <div style={{ padding: "10px 16px 14px", textAlign: "center" }}>
          <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void more()}>{loading ? "Loading…" : "Load more"}</button>
        </div>
      )}
    </section>
  );
}

function Row({ r, open, flash, onToggle }: { r: TimelineRow; open: boolean; flash: boolean; onToggle: () => void }) {
  const isThread = r.type === "email" && !!r.thread;
  const many = isThread && (r.thread?.count ?? 1) > 1;
  const openThread = () => window.dispatchEvent(new CustomEvent("crm:comms", { detail: { tab: "email", thread: r.thread?.id } }));
  return (
    <div id={`act-${r.id}`} className="crm-tl-item" data-flash={flash}>
      <div className="crm-tl-row">
        <span className="crm-tl-chip"><ActivityTypeBadge type={r.type} /></span>
        {r.type === "call" && r.state && r.state !== "completed" && <CallStateBadge state={r.state} />}
        <span className="crm-tl-main">
          {isThread
            ? <button type="button" className="crm-tl-title crm-textlink" onClick={openThread} title="Open in Communications">{r.title}</button>
            : r.type === "call" && r.callId
              ? <Link className="crm-tl-title crm-link" href={`/crm/communications/calls?call=${r.callId}`}>{r.title}</Link>
              : <span className="crm-tl-title">{r.title}</span>}
          {many && <span className="crm-tl-meta"> · {r.thread!.count} messages{r.who ? ` · last from ${r.who}` : ""}</span>}
          {!many && r.preview && <span className="crm-tl-preview"> — {r.preview}</span>}
        </span>
        {!many && r.who && <span className="crm-tl-who">{r.who}</span>}
        <span className="crm-tl-time" title={fmtDateTime(r.occurredAt)}>{rowTime(r.occurredAt)}</span>
        {isThread
          ? <button type="button" className="crm-tl-toggle" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={onToggle}>{open ? "▾" : "▸"}</button>
          : <span className="crm-tl-toggle" aria-hidden="true" />}
      </div>
      {open && isThread && <ThreadMessages threadId={r.thread!.id} single={!many} />}
    </div>
  );
}

function ThreadMessages({ threadId, single }: { threadId: string; single: boolean }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [openMsg, setOpenMsg] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/crm/timeline/thread/${threadId}`).then((r) => r.json()).then((j) => { if (live) { setMsgs(j.messages ?? []); if (single && j.messages?.[0]) setOpenMsg(j.messages[0].id); } }).catch(() => live && setMsgs([]));
    return () => { live = false; };
  }, [threadId, single]);
  if (!msgs) return <div className="crm-tl-sub"><span className="crm-tl-meta">Loading…</span></div>;
  return (
    <div className="crm-tl-sub">
      {msgs.map((m) => (
        <div key={m.id} className="crm-tl-msg">
          <button type="button" className="crm-tl-row crm-tl-msgrow" aria-expanded={openMsg === m.id} onClick={() => setOpenMsg(openMsg === m.id ? null : m.id)}>
            <span className="crm-tl-dir">{m.direction === "outbound" ? "↗" : "↙"}</span>
            <span className="crm-tl-main"><span className="crm-tl-who-strong">{m.who ?? "Unknown"}</span><span className="crm-tl-preview"> — {oneLine(m.new_text) || "(no new text)"}</span></span>
            <span className="crm-tl-time" title={fmtDateTime(m.at)}>{fmtAgo(m.at)}</span>
          </button>
          {openMsg === m.id && (
            <div className="crm-tl-body">
              <p>{m.new_text || "(no new text — only quoted history)"}</p>
              {m.full_text && m.full_text.length > m.new_text.length + 20 && (
                quoted === m.id
                  ? <><pre className="crm-tl-quoted">{m.full_text}</pre><button type="button" className="crm-textlink" onClick={() => setQuoted(null)}>Hide quoted history</button></>
                  : <button type="button" className="crm-textlink" onClick={() => setQuoted(m.id)}>Show quoted history</button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
