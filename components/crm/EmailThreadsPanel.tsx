"use client";

// Email threads for a company or contact (company / contact pages). Open threads by default (open +
// waiting), with Closed / All chips. Rows open the thread in a slide-over (reply from there); "New email"
// composes from Support / Feeds without leaving the record. The table is fixed-layout so it always fits
// its card: the subject takes the flexible width and truncates, the other columns are fixed (header widths), and narrow
// cards drop Mailbox, then Last from (.crm-threads container queries in crm-theme.css).

import { useCallback, useEffect, useState } from "react";
import SlideOver from "./SlideOver";
import ThreadView, { STATUS_LABEL } from "./ThreadView";
import { ComposeNew } from "./CompanyContextRail";
import { fmtAgo } from "@/lib/crm/format";
import { displaySubject } from "@/lib/crm/thread-display";

type Row = { id: string; subject: string | null; status: string; unread: boolean; last_message_at: string | null; last_from_name: string | null; last_from_email: string | null; last_snippet: string | null; message_count: number; mailbox_label: string | null };
export type ThreadFilter = "active" | "closed" | "all";
export type ThreadCounts = { filter: ThreadFilter; shown: number; active: number; closed: number; all: number };
const FILTERS: [ThreadFilter, string][] = [["active", "Open"], ["closed", "Closed"], ["all", "All"]];

export default function EmailThreadsPanel({ companyId, contactId, meId, to, filter: initialFilter = "active", onCounts }: {
  companyId?: string | null; contactId?: string | null; meId: string; to?: { email: string; name?: string }[];
  filter?: ThreadFilter; onCounts?: (c: ThreadCounts) => void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>(initialFilter);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ view: filter });
    if (contactId) qs.set("contact_id", contactId); else if (companyId) qs.set("company_id", companyId);
    const j = await fetch(`/api/crm/inbox/threads?${qs}`).then((r) => r.json()).catch(() => ({}));
    setRows(j.threads ?? []);
    setTotal(j.total ?? 0);
    const c: Record<string, number> = j.counts ?? {};
    setCounts(c);
    onCounts?.({ filter, shown: c[filter] ?? j.total ?? 0, active: c.active ?? 0, closed: c.closed ?? 0, all: c.all ?? 0 });
  }, [companyId, contactId, filter, onCounts]);
  useEffect(() => { void load(); }, [load]);

  const empty = filter === "active" ? "No open threads." : filter === "closed" ? "No closed threads." : "No email yet.";

  return (
    <div className="crm-threads">
      <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {FILTERS.map(([k, label]) => (
            <button key={k} type="button" className="crm-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}{counts[k] != null && <span style={{ marginLeft: 5, opacity: 0.7 }}>{counts[k]}</span>}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-primary" style={{ height: 30 }} onClick={() => setCompose(true)}>New email</button>
      </div>
      {!rows && <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>Loading…</p>}
      {rows && !rows.length && <p className="text-sm" style={{ color: "var(--text-muted)", padding: "0 16px 16px", margin: 0 }}>{empty}</p>}
      {rows && rows.length > 0 && (
        <table className="crm-threads-table">
          <thead>
            <tr>
              <th>Subject</th>
              <th className="c-from" style={{ width: 150 }}>Last from</th>
              <th className="c-mailbox" style={{ width: 80 }}>Mailbox</th>
              <th style={{ width: 92 }}>Status</th>
              <th style={{ width: 124 }}>Last message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const subject = displaySubject(t.subject) || "(no subject)";
              const from = t.last_from_name ?? t.last_from_email ?? "—";
              return (
                <tr key={t.id} onClick={() => setOpen(t.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") setOpen(t.id); }}>
                  <td title={t.subject ?? undefined}>
                    <div className="crm-ellipsis" style={{ color: "var(--blue)", fontWeight: t.unread ? 700 : 500 }}>
                      {subject}{t.message_count > 1 && <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> ({t.message_count})</span>}
                    </div>
                    {t.last_snippet && <div className="crm-ellipsis" style={{ fontSize: 12, color: "var(--text-muted)" }}>{t.last_snippet}</div>}
                  </td>
                  <td className="c-from"><div className="crm-ellipsis" title={from}>{from}</div></td>
                  <td className="c-mailbox"><div className="crm-ellipsis">{t.mailbox_label ?? "—"}</div></td>
                  <td><div className="crm-ellipsis">{STATUS_LABEL[t.status] ?? t.status}</div></td>
                  <td><div className="crm-ellipsis">{fmtAgo(t.last_message_at)}</div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows && total > rows.length && (
        <p style={{ margin: 0, padding: "8px 16px 12px", fontSize: 12, color: "var(--text-muted)" }}>Showing the latest {rows.length} of {total} — the Inbox has the rest.</p>
      )}
      <SlideOver open={!!open} title="Email thread" onClose={() => { setOpen(null); void load(); }} width={820}>
        {open && <ThreadView threadId={open} meId={meId} onChanged={load} />}
      </SlideOver>
      <SlideOver open={compose} title="New email" onClose={() => setCompose(false)} width={760}>
        {compose && <ComposeNew companyId={companyId ?? null} contactId={contactId ?? null} to={to ?? []} onDone={() => { setCompose(false); void load(); }} onCancel={() => setCompose(false)} />}
      </SlideOver>
    </div>
  );
}
